"""The Alert leg (0DTE + 1DTE by 15:30, 0.35; the live rule) with the live bot's limits (the user, 2026-10-26: "test
this bot when it can't loose more than 5% in one day"). Each day's trades in buy-minute order; a trade is refused when
  day loss   the day's closed trades (sold before its buy minute) have lost 5% of the morning's account (dayLossPct 5)
  max trades 5 trades already bought today (maxTradesPerDay 5)
  max open   3 trades open at its buy minute (maxOpen 3)
Versions: none, the day loss alone, all three (the live bot); sizes 1-6%; ±2% fill (±4% as a check). The worst day and
the worst drop are on closed trades, as everywhere in this research.

  BT_UNIVERSE=wide node --env-file=.env <path>/run.mjs leg_daycap.py
  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node ... leg_daycap.py
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from levels import ctx
import leg_fallback as LF
from leg_export import entries

CAL = calendar()
C = sim.C
K, WAIT, DELTA, COMM = 0.25, 60, 0.35, 0.62


def one(sig):
    date, sym, m, kind, alert = sig
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if m not in sb or not x or not x.get("sd"): return None
    u, stock0 = x["sd"], sb[m][4]
    side = None
    for t in range(m + 1, m + WAIT + 1):
        if t in sb and abs(sb[t][4] / stock0 - 1) >= K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
    if not side: return None
    ct, right = side; spot = sb[ct][4]
    if kind == "0": C.update(dte_min=0, dte_max=0, delta=DELTA)
    else: C.update(dte_min=1, dte_max=5, delta=DELTA)
    got, why = sim.pick(sym, date, ct, right, spot)
    if got is None: return None
    if kind == "1" and got[1] != CAL[CAL.index(date) + 1]: return None
    w = LF.walk(sym, date, ct, right, got[0], spot, u)
    if not w: return None
    return dict(buy=w[0], sell=w[1], bm=w[2], xm=w[3])


def account(T, size, fill=2, loss=None, max_trades=None, max_open=None):
    eq, rows, days, refused = 1e5, [], {}, {"loss": 0, "trades": 0, "open": 0}
    by_day = {}
    for t in T: by_day.setdefault(t["date"], []).append(t)
    for d in sorted(by_day):
        start = eq; done = []   # (exit minute, pnl, buy minute)
        for t in sorted(by_day[d], key=lambda t: (t["bm"], t["minute"])):
            closed = sum(p for x, p, b in done if x < t["bm"])
            if loss and closed <= -loss / 100 * start: refused["loss"] += 1; continue
            if max_trades and len(done) >= max_trades: refused["trades"] += 1; continue
            if max_open and sum(1 for x, p, b in done if x >= t["bm"]) >= max_open: refused["open"] += 1; continue
            buy = t["buy"] if fill == 2 else t["buy"] / 1.02 * 1.04
            sell = t["sell"] if fill == 2 else t["sell"] / 0.98 * 0.96
            q = int(size / 100 * start // (buy * 100))
            if q < 1: continue
            pnl = q * (sell - buy) * 100 - COMM * 2 * q
            done.append((t["xm"], pnl, t["bm"])); rows.append(dict(t, pnl=pnl))
        dp = sum(p for x, p, b in done); eq += dp; days[d] = dp / start
    # the account after each closed trade, in exit order within the day, for the drop
    peak, dd, e = 1e5, 0.0, 1e5
    for d in sorted(by_day):
        for r in sorted((r for r in rows if r["date"] == d), key=lambda r: r["xm"]):
            e += r["pnl"]; peak = max(peak, e); dd = max(dd, 1 - e / peak)
    return eq, dd, rows, min(days.values()) if days else 0, refused


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    ent = [e for e in entries() if lo <= e[0] <= hi]
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], right="C", r=r) for e, r in zip(ent, res) if r]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    T = [dict(date=t["date"], minute=t["minute"], sym=t["sym"], **t["r"]) for t in rows
         if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)]
    days_n = len({t["date"] for t in T})
    per_day = {}
    for t in T: per_day[t["date"]] = per_day.get(t["date"], 0) + 1
    print(f"{len(T)} trades on {days_n} days; days with 6+ trades: {sum(v > 5 for v in per_day.values())}, most in a day {max(per_day.values())}")
    print("\n| Size | Limits | Trades | Refused (loss / 5 a day / 3 open) | ±2%: end, worst drop | worst day | without best 5 | ±4%: end, worst drop |")
    print("|---|---|---|---|---|---|---|---|")
    for size in (1, 2, 3, 4, 6):
        for lab, kw in (("none", {}), ("day loss 5%", dict(loss=5)), ("the live bot: loss 5%, 5 a day, 3 open", dict(loss=5, max_trades=5, max_open=3))):
            e1, d1, R, wd, rf = account(T, size, 2, **kw)
            top = {(r["date"], r["sym"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
            e5 = account([t for t in T if (t["date"], t["sym"]) not in top], size, 2, **kw)[0]
            e4, d4, _, _, _ = account(T, size, 4, **kw)
            print(f"| {size}% | {lab} | {len(R)} | {rf['loss']} / {rf['trades']} / {rf['open']} | ${e1:,.0f}, {100 * d1:.1f}% | {100 * wd:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% |")


if __name__ == "__main__":
    main()
