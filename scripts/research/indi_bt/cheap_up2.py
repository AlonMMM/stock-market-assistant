"""The liquid fallback the user's way, on the live bot (the user, 2026-10-25: "do fallback but try first go to 0.1
delta, if you can't find any - go up until 0.3 delta"; "test the current production bot with the 2 fallback rules").
  liquid2: when the 0.15-delta option has under min_vol30 (200) contracts in the last 30 minutes, look first further
           out, delta 0.15 down to 0.10, for a strike that has them (and costs $0.20 or more), the nearest to 0.15;
           if none, toward the money, delta 0.15 up to 0.30, the nearest to 0.15.
  both2:   cheap (cheap_up.py: under $0.20, the nearest-the-money strike at $0.20 or more), then liquid2 on the result.
cheap_up.py's liquid (toward the money only, up to 0.35) and both are run beside them. Exits: the live bot 2.4 (2.3 +
the rest at -20% after the +10 half); the baseline must reproduce $695,450 / 9% on the fair list. Fair list and 151
unseen; 1% / 2% from $100,000.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs cheap_up2.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import news_filter as nf
from store import calendar
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = calendar()
C = sim.C
BOT24 = {**cu.BOT, "after_half": dict(out=-0.2)}
LOW, HIGH = 0.10, 0.30
MODES = ("plain", "cheap", "liquid", "both", "liquid2", "both2")


def liquid2(cands, best):
    """The user's order: further out to delta 0.10 first, then toward the money to 0.30; the nearest to 0.15 each way."""
    ok = [c for c in cands if c[5] >= C["min_vol30"] and c[4] >= C["min_price"]]
    out = [c for c in ok if LOW <= abs(c[3]) < abs(best[3])]
    if out: return max(out, key=lambda c: abs(c[3]))
    up = [c for c in ok if abs(best[3]) <= abs(c[3]) <= HIGH]
    if up: return min(up, key=lambda c: abs(c[3]))
    return None


def choose(cands, mode):
    if mode in ("cheap", "liquid", "both"): return cu.choose(cands, mode)
    if not cands: return None, "no_prices"
    best = min(cands, key=lambda c: abs(c[3] - C["delta"]))
    if mode == "both2" and best[4] < C["min_price"]:
        ok = [c for c in cands if c[4] >= C["min_price"] and abs(c[3]) >= abs(best[3])]
        if not ok: return None, "too_cheap"
        best = min(ok, key=lambda c: c[4])
    if best[5] < C["min_vol30"]:
        best = liquid2(cands, best)
        if not best: return None, "illiquid"
    if best[4] < C["min_price"]: return None, "too_cheap"
    return best, None


def one(t):
    key = (t["date"], t["sym"], t["minute"])
    out = {}
    minute, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], minute, t["right"], spot) if t["status"] in ("too_cheap", "illiquid") else []
    for mode in MODES:
        if t["status"] == "ok": p = (t["contract"], t["expiry"], None)
        elif mode == "plain": continue
        else:
            c, _ = choose(cands, mode)
            if not c: continue
            p = (c[0], c[1], c)
        sim.X.clear(); sim.X.update(BOT24)
        cost, steps, _ = sim.walk(t["sym"], t["date"], minute, t["right"], p[0], p[1], CAL)
        if cost is None: continue
        out[mode] = sim.result(cost, steps)
        if p[2]: out[mode + "|pick"] = (round(abs(p[2][3]), 3), p[2][4], p[2][5])
    return key, out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(pool.map(one, T, chunksize=8))
    key = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t)]
        print(f"\n### {lname}: {len(L)} signals ({sum(t['status'] == 'too_cheap' for t in L)} too cheap, {sum(t['status'] == 'illiquid' for t in L)} illiquid)\n")
        print("| Pick | Trades | Winners | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Added: n, winners, per trade, sum | Added without their best 5 |\n|---|---|---|---|---|---|---|---|---|")
        for mode in MODES:
            rows = [dict(date=t["date"], pnl=str(pt(R[key(t)][mode])), added=t["status"] != "ok") for t in L if mode in R[key(t)]]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            top = set(sorted(range(len(rows)), key=lambda i: -float(rows[i]["pnl"]))[:5])
            a5, _ = account([r for i, r in enumerate(rows) if i not in top])
            yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            add = sorted((float(r["pnl"]) for r in rows if r["added"]), reverse=True)
            added = f"{len(add)}, {sum(x > 0 for x in add)}, {sum(add) / len(add):+,.0f}, {sum(add) / 1e3:+,.0f}K" if add else ""
            wo = f"{sum(add[5:]) / 1e3:+,.0f}K" if add else ""
            print(f"| {mode} | {len(rows)} | {sum(float(r['pnl']) > 0 for r in rows)} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {added} | {wo} |", flush=True)
        add = sorted(((pt(R[key(t)]["liquid2"]), t["sym"], t["date"], R[key(t)]["liquid2|pick"]) for t in L if t["status"] == "illiquid" and "liquid2" in R[key(t)]), reverse=True)
        if add:
            lo = [a for a in add if a[3][0] < C["delta"]]
            print(f"\nliquid2: {len(add)} illiquid signals re-picked, {len(lo)} further out (delta < 0.15: {sum(a[0] for a in lo) / 1e3:+,.0f}K), "
                  f"{len(add) - len(lo)} toward the money ({sum(a[0] for a in add if a[3][0] >= C['delta']) / 1e3:+,.0f}K); delta median {st.median(a[3][0] for a in add):.2f}, "
                  f"price median ${st.median(a[3][1] for a in add):.2f}; best", [(s, d, f"{x:+,.0f}") for x, s, d, _ in add[:5]], "worst", [(s, d, f"{x:+,.0f}") for x, s, d, _ in add[-3:]])


if __name__ == "__main__":
    main()
