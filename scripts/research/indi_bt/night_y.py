"""V2: rules for the big carried winners only (the user's ideas, 2026-10-23). Only trades held overnight that were up
>= +400% (also 300% / 500%) at the first 15:50 hold; every champion rule stays.
  1  from 10:00 (17:00 Israel) on a carried day: sell all when the option is X% under last night's 15:50 price
     (40 / 50 / 60%), or (the other reading) when the trade's gain falls under +50% of the price paid
  2  after the morning gap sale: sell the rest when the option is X% under its highest close since the buy (30/40/50%)
  1+2 together at 400%: -50% from last night's price and the 40% trail
Same trades (t >= 1.8, news filter, delta 0.15), each walked again; 1% / 2% of the start-of-day account from $100,000.

  python3 night_y.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import calendar
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account, held

B = "data/local/x/bt"
CAL = calendar()
X0 = {**sim.X, **H, **NIGHT}
VERSIONS = [("Champion", None)]
for m in (3, 4, 5):
    for x in (0.4, 0.5, 0.6): VERSIONS.append((f"1: {100 * m}%+, -{100 * x:.0f}% from last night", {"min_first": m, "from": 30, "stop_ref": -x}))
    VERSIONS.append((f"1: {100 * m}%+, gain under +50% of cost", {"min_first": m, "from": 30, "stop_cost": 0.5}))
for m in (3, 4, 5):
    for x in (0.3, 0.4, 0.5): VERSIONS.append((f"2: {100 * m}%+, trail {100 * x:.0f}% from the high", {"min_first": m, "trail": x}))
VERSIONS.append(("1+2: 400%+, -50% and trail 40%", {"min_first": 4, "from": 30, "stop_ref": -0.5, "trail": 0.4}))




def walk(t):
    out = {}
    for lab, ny in VERSIONS:
        sim.X.clear(); sim.X.update(X0 if ny is None else {**X0, "night_y": ny})
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: out[lab] = None; continue
        carry = next((s for s in steps if s[2] == "carry"), None)
        out[lab] = (sim.result(cost, steps), None if carry is None else carry[4] / cost - 1,
                  held(cost, steps))
    return (t["date"], t["sym"], t["minute"]), out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(pool.map(walk, T, chunksize=10))
    key = lambda t: (t["date"], t["sym"], t["minute"])
    fair = [t for t in T if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and all(R[key(t)][l] for l, _ in VERSIONS)]
    uns = [t for t in T if t["sym"] not in HIS40 and all(R[key(t)][l] for l, _ in VERSIONS)]
    acc = lambda L, lab, pct=0.01: account([dict(t, pnl=str(1e4 * max(-1, R[key(t)][lab][0])), **R[key(t)][lab][2]) for t in L], pct)
    for m in (3, 4, 5):
        big = [t for t in fair if (R[key(t)]["Champion"][1] or -9) >= m]
        print(f"fair list, held at +{100 * m}%+: {len(big)}:", [(t["date"], t["sym"], t["right"], f"{R[key(t)]['Champion'][1]:+.0%}", f"{R[key(t)]['Champion'][0]:+.0%}") for t in big] if m == 4 else "")
    print("\n| Version | Changed (fair / unseen) | Fair per trade 2024 / 2025 / 2026 | Fair at 1% | Fair at 2% | Without the most helped trade, 1% (champion) | Unseen at 1% |\n|---|---|---|---|---|---|---|")
    for lab, _ in VERSIONS:
        ch = [t for t in fair if abs(R[key(t)][lab][0] - R[key(t)]["Champion"][0]) > 1e-9]
        chu = sum(abs(R[key(t)][lab][0] - R[key(t)]["Champion"][0]) > 1e-9 for t in uns)
        yr = [[1e4 * max(-1, R[key(t)][lab][0]) for t in fair if t["date"][:4] == y] for y in ("2024", "2025", "2026")]
        a1, d1 = acc(fair, lab); a2, d2 = acc(fair, lab, 0.02); u1, ud = acc(uns, lab)
        best = max(fair, key=lambda t: R[key(t)][lab][0] - R[key(t)]["Champion"][0])
        wo = [t for t in fair if t is not best]
        b1, _ = acc(wo, lab); c1, _ = acc(wo, "Champion")
        print(f"| {lab} | {len(ch)} / {chu} | " + " / ".join(f"{st.fmean(v):+,.0f}" for v in yr) + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% | ${b1:,.0f} (${c1:,.0f}) | ${u1:,.0f}, {100 * ud:.0f}% |", flush=True)
        if lab.startswith(("1: 400%+, -50%", "2: 400%+, trail 40%", "1+2")):
            d = sorted(((R[key(t)][lab][0] - R[key(t)]["Champion"][0], t) for t in ch), key=lambda x: x[0])
            print("|  | " + ", ".join(f"{t['sym']} {t['date']} {x:+.0%}" for x, t in d) + " | | | | | |")


if __name__ == "__main__":
    main()
