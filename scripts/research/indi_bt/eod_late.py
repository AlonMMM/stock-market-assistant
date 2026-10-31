"""V2: the day-end decision later. The champion decides at 15:50 (minute 380): a trade up +100% or more is held
overnight, the rest is sold on the next bar. Here the decision (and the sale of what is not held) waits until
15:55 or 15:58 (sold on the 15:59 bar); until then the champion's stops keep working. Same trades (t >= 1.8,
news filter, delta 0.15), each walked again; 1% / 2% of the start-of-day account from $100,000.

  python3 eod_late.py [minute ...]      (from the repo root; default 385 388)
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
from score_sum import account, held as booked

B = "data/local/x/bt"
CAL = calendar()
X0 = {**sim.X, **H, **NIGHT}
VERSIONS = [("15:50 (champion)", 380), ("15:55", 385), ("15:58, sold on the last bar", 388)]
if len(sys.argv) > 1:  # other decision minutes, e.g. 370 375 (session minutes; 380 = 15:50)
    VERSIONS = [("15:50 (champion)", 380)] + [(f"{9 + (30 + int(m)) // 60}:{(30 + int(m)) % 60:02d}", int(m)) for m in sys.argv[1:]]


def walk(t):
    out = {}
    for _, m in VERSIONS:
        sim.X.clear(); sim.X.update({**X0, "eod_minute": m})
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        out[m] = None if cost is None else (sim.result(cost, steps), any(s[5] == "eod_carry" for s in steps),
                                             booked(cost, steps))
    return (t["date"], t["sym"], t["minute"]), out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(pool.map(walk, T, chunksize=10))
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and all(R[(t["date"], t["sym"], t["minute"])][m] for _, m in VERSIONS)]
        print(f"\n### {lname}: {len(L)} trades\n")
        print("| Day-end decision | Held overnight | Per trade 2024 / 2025 / 2026 | At 1% | At 2% |\n|---|---|---|---|---|")
        for lab, m in VERSIONS:
            rows = [dict(t, pnl=str(1e4 * max(-1, R[(t["date"], t["sym"], t["minute"])][m][0])),
                         **R[(t["date"], t["sym"], t["minute"])][m][2]) for t in L]
            held = sum(R[(t["date"], t["sym"], t["minute"])][m][1] for t in L)
            yr = [[float(x["pnl"]) for x in rows if x["date"][:4] == y] for y in ("2024", "2025", "2026")]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            print(f"| {lab} | {held} | " + " / ".join(f"{st.fmean(v):+,.0f}" for v in yr) + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |", flush=True)
        # Where the late decision changes a trade most.
        diffs = sorted(((R[(t["date"], t["sym"], t["minute"])][VERSIONS[-1][1]][0] - R[(t["date"], t["sym"], t["minute"])][380][0], t) for t in L), key=lambda x: x[0])
        print("\nmost hurt:", [(t["date"], t["sym"], t["right"], f"{d:+.0%}") for d, t in diffs[:5]])
        print("most helped:", [(t["date"], t["sym"], t["right"], f"{d:+.0%}") for d, t in diffs[-5:]])


if __name__ == "__main__":
    main()
