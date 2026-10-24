"""A wider stop right after the entry (the user, 2026-10-24: "check 50% stop only for the first 10 minutes"). The bot
today (champion + the failed-break sale), but the -30% stop is -50% in the first N minutes after the entry, then -30%
as today; the +10 / +20 checks and the failed-break sale keep their times. Main version -50% / 10 min; neighbours
(-40% / 10, -50% / 5, -50% / 20) to see whether it is a ridge or a spike. All champion trades 2024-2026, fair list and
151 unseen; 1% / 2% of the start-of-day account from $100,000. sim.py: early_out.

  python3 ../sma-indi-backtest/scripts/research/indi_bt/early_stop50.py      (from the repo root)
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
VERSIONS = [("Bot today (-30% from the start)", None), ("-50% for 10 min", (10, -0.5)), ("-40% for 10 min", (10, -0.4)),
            ("-50% for 5 min", (5, -0.5)), ("-50% for 20 min", (20, -0.5))]


def one(t):
    out = {}
    for name, eo in VERSIONS:
        sim.X.clear(); sim.X.update(X0)
        if eo: sim.X["early_out"] = dict(min=eo[0], out=eo[1])
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: return None
        out[name] = sim.result(cost, steps)
    return (t["date"], t["sym"], t["minute"]), out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(r for r in pool.map(one, T, chunksize=8) if r)
    key = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    base = VERSIONS[0][0]
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and key(t) in R]
        print(f"\n### {lname}: {len(L)} trades\n")
        print("| Version | Winners | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Trades changed, their sum vs today |\n|---|---|---|---|---|---|---|")
        for name, _ in VERSIONS:
            rows = [dict(date=t["date"], pnl=str(pt(R[key(t)][name]))) for t in L]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            top = set(sorted(range(len(rows)), key=lambda k: -float(rows[k]["pnl"]))[:5])
            a5, _ = account([r for k, r in enumerate(rows) if k not in top])
            yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            ch = [t for t in L if abs(R[key(t)][name] - R[key(t)][base]) > 1e-9]
            diff = sum(pt(R[key(t)][name]) - pt(R[key(t)][base]) for t in ch)
            win = sum(R[key(t)][name] > 0 for t in L)
            print(f"| {name} | {win} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {len(ch)}, {diff:+,.0f} |")
        main_v = VERSIONS[1][0]
        ch = sorted(((pt(R[key(t)][main_v]) - pt(R[key(t)][base]), t["sym"], t["date"]) for t in L if abs(R[key(t)][main_v] - R[key(t)][base]) > 1e-9), reverse=True)
        print(f"\n{main_v}: biggest gains", [(s, d, f"{x:+,.0f}") for x, s, d in ch[:5]], "biggest losses", [(s, d, f"{x:+,.0f}") for x, s, d in ch[-5:]])


if __name__ == "__main__":
    main()
