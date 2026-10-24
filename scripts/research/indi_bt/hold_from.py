"""V2: the overnight hold threshold on the chosen bot (the champion + the failed-break sale). The champion holds what is
up >= +100% at 15:50; night_levels.py (2026-10-24) found +50% better, so the neighbours are checked: +25 / +50 / +75 /
+100 / +150%, on the fair list and the 151 unseen, at delta 0.15 (the chosen bot's trades; HF_PREFIX=sd10_t18r15 for delta 0.10). 1% / 2% from $100,000.

  python3 hold_from.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import calendar
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = calendar()
X0 = {**sim.X, **H, **NIGHT, "failed_break": True}
GAINS = (0.25, 0.5, 0.75, 1.0, 1.5)
PREFIX = os.environ.get("HF_PREFIX", "s_t18r15")  # sd10_t18r15: the same signals at delta 0.10


def walk(t):
    out = {"key": (t["date"], t["sym"], t["minute"])}
    for g in GAINS:
        sim.X.clear(); sim.X.update(X0); sim.X["carry_min_gain"] = g
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: return None
        out[g] = (sim.result(cost, steps), any(s[2] == "carry" for s in steps))
    return out


def main():
    T = [t for f in glob.glob(f"{B}/{PREFIX}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(8) as pool: R = {r["key"]: r for r in pool.map(walk, T, chunksize=10) if r}
    key = lambda t: (t["date"], t["sym"], t["minute"])
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and key(t) in R]
        print(f"\n### {lname}: {len(L)} trades\n\n| Hold from | Held | Account at 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 (P&L at $10K) | Without best 5, at 1% |\n|---|---|---|---|---|---|")
        for g in GAINS:
            rows = [dict(date=t["date"], pnl=str(1e4 * max(-1, R[key(t)][g][0]))) for t in L]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            top = set(sorted(range(len(rows)), key=lambda k: -float(rows[k]["pnl"]))[:5])
            a5, _ = account([x for k, x in enumerate(rows) if k not in top])
            yr = " / ".join(f"{sum(float(x['pnl']) for x in rows if x['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            print(f"| +{int(g * 100)}% | {sum(R[key(t)][g][1] for t in L)} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} |", flush=True)


if __name__ == "__main__":
    main()
