"""The Alert leg with the two contract fallbacks (the user, 2026-10-25: "try to add the 2 fallbacks. cheap and liquid").
The one-leg rule as the live bot runs it (apps/trader/src/strangle.ts): the first volume alert of the stock's day
(09:40-13:00, same-day expiry, news filter); the side when the stock moves 0.25 S30 from its price at the alert, within
60 minutes; at the side the 0.35-delta leg of that day's expiry is picked and bought (bar middle + 2%); sold when the
stock gives back 0.75 S30 from its best since the side, out by 15:30 (bar middle - 2%); $0.62 a contract each way.
The pick at the side, four ways:
  plain   the 0.35-delta strike, $0.20 or more and 200+ contracts in the last 30 minutes, or no trade (the live bot)
  cheap   under $0.20: the nearest-the-money strike at $0.20 or more, the one closest to $0.20 (a higher delta)
  liquid  under 200 contracts: first further out (delta down to 0.25), then toward the money (up to 0.50), the
          nearest to 0.35 with 200 contracts and $0.20 (the user's order from cheap_up2.py)
  both    cheap, then liquid on the result
Accounts in whole contracts from 1% (and 2%) of each morning's account, from $100,000, at the +/-2% and +/-4% fills.

  BT_UNIVERSE=wide node --env-file=.env <path>/run.mjs leg_fallback.py                     (Indi's fair list)
  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node ... leg_fallback.py    (the Favorites year)
"""
import multiprocessing as mp, os, sys, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from levels import ctx
import zero5
from cheap_up import candidates

DELTA, K, WAIT, GIVE, END, SH, COMM = 0.35, 0.25, 60, 0.75, 360, 0.02, 0.62
EARLY_GIVE = float(os.environ.get("STR_EARLY_GIVE", "0"))   # a wider give-back for the first EARLY_MIN minutes (0: off)
EARLY_MIN = int(os.environ.get("STR_EARLY_MIN", "5"))
LOW, HIGH = 0.25, 0.50
MODES = ("plain", "cheap", "liquid", "both")
C = sim.C


def choose(cands, mode):
    if not cands: return None
    best = min(cands, key=lambda c: abs(abs(c[3]) - DELTA))
    if mode in ("cheap", "both") and best[4] < C["min_price"]:
        ok = [c for c in cands if c[4] >= C["min_price"] and abs(c[3]) >= abs(best[3])]
        if not ok: return None
        best = min(ok, key=lambda c: c[4])
    if mode in ("liquid", "both") and best[5] < C["min_vol30"]:
        ok = [c for c in cands if c[5] >= C["min_vol30"] and c[4] >= C["min_price"]]
        out = [c for c in ok if LOW <= abs(c[3]) < abs(best[3])]
        up = [c for c in ok if abs(best[3]) <= abs(c[3]) <= HIGH]
        if out: best = max(out, key=lambda c: abs(c[3]))
        elif up: best = min(up, key=lambda c: abs(c[3]))
        else: return None
    if best[4] < C["min_price"] or best[5] < C["min_vol30"]: return None
    return best


def walk(sym, date, ct, side, contract, spot_side, u):
    """Buy at the side, sell on the stock's give-back. -> (buy, sell, buy_minute, exit_minute) or None."""
    kb = {b[0]: b for b in day(contract, date)}
    sb = {b[0]: b for b in day(sym, date)}
    b0 = next((kb[q] for q in range(ct, ct + 4) if q in kb), None)
    if not b0: return None
    buy = sim.mid(b0) * (1 + SH); last = b0; best = spot_side
    for t in range(b0[0] + 1, END + 1):
        if t in kb: last = kb[t]
        spot = sb[t][4] if t in sb else None
        if spot: best = max(best, spot) if side == "C" else min(best, spot)
        give = GIVE
        if EARLY_GIVE and t - b0[0] <= EARLY_MIN: give = EARLY_GIVE
        if t >= END or (spot and abs(spot / best - 1) >= give * u):
            return buy, max(sim.mid(last) * (1 - SH), 0.01), b0[0], t
    return buy, max(sim.mid(last) * (1 - SH), 0.01), b0[0], END


def one(sig):
    date, sym, m, alert = sig
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if m not in sb or not x or not x.get("sd"): return None
    u, stock0 = x["sd"], sb[m][4]
    side = None
    for t in range(m + 1, m + WAIT + 1):
        if t in sb and abs(sb[t][4] / stock0 - 1) >= K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
    if not side: return dict(status="no_side")
    ct, right = side; spot = sb[ct][4]
    C.update(dte_min=0, dte_max=0, delta=DELTA)
    first, why = sim.pick(sym, date, ct, right, spot)   # downloads the chain's bars into the cache
    if first is None and why not in ("too_cheap", "illiquid"): return dict(status=why)
    cands = candidates(sym, date, ct, right, spot)
    out = dict(status="ok" if first else why, side=right, side_minute=ct)
    for mode in MODES:
        c = choose(cands, mode)
        if not c: continue
        w = walk(sym, date, ct, right, c[0], spot, u)
        if w: out[mode] = dict(contract=c[0], delta=round(abs(c[3]), 3), price=c[4], vol30=c[5], buy=w[0], sell=w[1], buy_minute=w[2], exit_minute=w[3])
    return out


def account(trades, size, fill):
    eq, cur, start, rows = 1e5, None, 1e5, []
    for t in sorted(trades, key=lambda t: (t["date"], t["minute"])):
        if t["date"] != cur: cur, start = t["date"], eq
        buy = t["buy"] if fill == 2 else t["buy"] / 1.02 * 1.04
        sell = t["sell"] if fill == 2 else t["sell"] / 0.98 * 0.96
        q = int(size / 100 * start // (buy * 100))
        if q < 1: continue
        pnl = q * (sell - buy) * 100 - COMM * 2 * q
        eq += pnl; rows.append(dict(t, pnl=pnl, account=eq))
    peak, dd = 1e5, 0.0
    for r in rows: peak = max(peak, r["account"]); dd = max(dd, 1 - r["account"] / peak)
    return eq, dd, rows


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    ent = [e for e in zero5.entries() if lo <= e[0] <= hi]
    print(len(ent), "first alerts", flush=True)
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], right="C", r=r) for e, r in zip(ent, res) if r]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)]
    stat = {}
    for t in keep: stat[t["r"]["status"]] = stat.get(t["r"]["status"], 0) + 1
    print("after the news filter and the list:", len(keep), stat)
    by = {m: [dict(date=t["date"], minute=t["minute"], sym=t["sym"], status=t["r"]["status"], **t["r"][m]) for t in keep if m in t["r"]] for m in MODES}
    base = {(t["date"], t["sym"]) for t in by["plain"]}
    print("\n| Pick | Trades | Added | Winners | 1%, ±2%: end, worst drop | without best 5 | added trades' P&L | 1%, ±4% | 2%, ±2% |")
    print("|---|---|---|---|---|---|---|---|---|")
    for m in MODES:
        T = by[m]
        e1, d1, R = account(T, 1, 2)
        top = {(r["date"], r["sym"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
        e5, _, _ = account([t for t in T if (t["date"], t["sym"]) not in top], 1, 2)
        added = [r for r in R if (r["date"], r["sym"]) not in base]
        e4, d4, _ = account(T, 1, 4); e2, d2, _ = account(T, 2, 2)
        print(f"| {m} | {len(R)} | {len(added)} | {100 * sum(r['pnl'] > 0 for r in R) / max(1, len(R)):.0f}% | ${e1:,.0f}, {100 * d1:.1f}% | ${e5:,.0f} | "
              f"{sum(r['pnl'] for r in added):+,.0f} on {len(added)} | ${e4:,.0f}, {100 * d4:.1f}% | ${e2:,.0f}, {100 * d2:.1f}% |")
        if m != "plain" and added:
            ds = [a["delta"] for a in added]; ps = [a["price"] for a in added]
            yrs = {}
            for r in added: yrs[r["date"][:4]] = yrs.get(r["date"][:4], 0) + r["pnl"]
            syms = {}
            for r in added: syms[r["sym"]] = syms.get(r["sym"], 0) + r["pnl"]
            top3 = sorted(syms.items(), key=lambda kv: -abs(kv[1]))[:5]
            print(f"|  ↳ added: delta median {st.median(ds):.2f}, price median ${st.median(ps):.2f}; by year "
                  + ", ".join(f"{y} {v:+,.0f}" for y, v in sorted(yrs.items())) + "; biggest " + ", ".join(f"{s} {v:+,.0f}" for s, v in top3) + " | | | | | | | | |")


if __name__ == "__main__":
    main()
