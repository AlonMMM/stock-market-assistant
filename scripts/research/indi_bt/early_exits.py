"""Exits in the first minutes (the user's question, 2026-10-24: "how many exits we have before the 10 minutes that might
cut off"). For the bot today (champion + the failed-break sale): the sales by rule in the first 10 minutes, what those
trades made, and what the same trades do when no -30% stop and no failed-break sale is allowed before 5 / 10 / 20
minutes (the +10 / +20 checks keep their times). All the champion's trades 2024-2026, fair list and 151 unseen; 1% / 2%
of the start-of-day account from $100,000. sim.py: first_exit_min.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs early_exits.py      (from the repo root)
"""
import collections, csv, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import calendar, day
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = calendar()
X0 = {**sim.X, **H, **NIGHT, "failed_break": True}
VERSIONS = [("Bot today", 0), ("No stop / failed break before 5 min", 5), ("No stop / failed break before 10 min", 10), ("No stop / failed break before 20 min", 20)]


def one(t):
    out = {}
    m0 = int(t["minute"])
    for name, n in VERSIONS:
        sim.X.clear(); sim.X.update(X0); sim.X["first_exit_min"] = n
        cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: return None
        sales = [s for s in steps if s[2] == "sell" and s[0] == t["date"]]
        first = min((s[1] - m0 for s in sales), default=None)
        out[name] = (sim.result(cost, steps), "|".join(s[5] for s in steps[1:]), first, sales[0][5] if sales else None)
    bars = day(t["contract"], t["date"])
    cost = out["Bot today"][0]
    return (t["date"], t["sym"], t["minute"]), out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(r for r in pool.map(one, T, chunksize=8) if r)
    key = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    for lname, lf in (("fair list (his 40, traded the year before)", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and key(t) in R]
        print(f"\n### {lname}: {len(L)} trades, 2024-2026\n")
        base = "Bot today"
        early = [t for t in L if R[key(t)][base][2] is not None and R[key(t)][base][2] < 10]
        byrule = collections.Counter(R[key(t)][base][3] for t in early)
        print(f"Sold within 10 minutes of the entry today: {len(early)} of {len(L)} trades (" + ", ".join(f"{r} {n}" for r, n in byrule.most_common()) + f"), "
              f"at $10K they made {sum(pt(R[key(t)][base][0]) for t in early):+,.0f}; the same trades with no stop / failed break before 10 min: "
              f"{sum(pt(R[key(t)]['No stop / failed break before 10 min'][0]) for t in early):+,.0f}, before 20 min: {sum(pt(R[key(t)]['No stop / failed break before 20 min'][0]) for t in early):+,.0f}.")
        mins = sorted(R[key(t)][base][2] for t in L if R[key(t)][base][2] is not None)
        print("First sale, minutes after the entry: " + ", ".join(f"≤{m}: {sum(1 for x in mins if x <= m)}" for m in (2, 5, 10, 20, 60)) + f" of {len(mins)} same-day sellers.\n")
        print("| Version | Winners | Per trade at $10K: 2024 / 2025 / 2026 | Without the best 5 (per trade) | At 1%, worst drop | At 2%, worst drop | Stop / failed-break sales |\n|---|---|---|---|---|---|---|")
        for name, _ in VERSIONS:
            rows = [dict(date=t["date"], sym=t["sym"], pnl=str(pt(R[key(t)][name][0]))) for t in L]
            pnl = [float(r["pnl"]) for r in rows]
            yr = [st.fmean([float(r["pnl"]) for r in rows if r["date"][:4] == y] or [0]) for y in ("2024", "2025", "2026")]
            wo = sorted(pnl)[:-5]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            c = collections.Counter(r for t in L for r in R[key(t)][name][1].split("|"))
            print(f"| {name} | {100 * sum(x > 0 for x in pnl) / len(pnl):.0f}% | " + " / ".join(f"{y:+,.0f}" for y in yr)
                  + f" | {sum(wo) / len(L):+,.0f} | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% | {c['U_out']} / {c['F_break']} |", flush=True)
        for name, _ in VERSIONS[1:]:
            d = [(pt(R[key(t)][name][0]) - pt(R[key(t)][base][0]), t) for t in L]
            ch = [x for x in d if abs(x[0]) > 1]
            top = sorted(ch, key=lambda x: -abs(x[0]))[:4]
            print(f"  {name}: {len(ch)} trades change ({sum(1 for x in ch if x[0] > 0)} better), sum {sum(x[0] for x in d):+,.0f} at $10K; biggest: " + ", ".join(f"{t['sym']} {t['date']} {x:+,.0f}" for x, t in top))


if __name__ == "__main__":
    main()
