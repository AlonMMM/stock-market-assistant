"""A tighter stop on the rest after the +10 half (the user, 2026-10-24: "be more careful with trades we already cut - maybe
move the stop higher"). Entry day only, set before running: R20 / R15 the rest at -20% / -15% with the stock against;
R20o -20% on the option alone; RHalf under the price the half was sold at; RStock the first minute after +20 with the
stock against the entry. Fair list and 151 unseen; 1% / 2% from $100,000. sim.py: after_half.

  python3 ../sma-indi-backtest/scripts/research/indi_bt/rest_stop.py      (from the repo root)
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
from score_sum import account, held
from levels import ctx

B = "data/local/x/bt"
CAL = calendar()
X0 = {**sim.X, **H, **NIGHT, "failed_break": True}
VERSIONS = [("Bot today", None), ("R20: rest -20%, stock against", dict(out=-0.2)), ("R15: rest -15%, stock against", dict(out=-0.15)),
            ("R20o: rest -20%, option alone", dict(out=-0.2, need_against=False)), ("RHalf: rest under the half's price", dict(out="half_px")),
            ("RStock: rest out when the stock is against after 20", dict(stock=True))]


def one(t):
    out = {}
    x = ctx(t["sym"], t["date"])
    unit = x["sd"] * float(t["price"]) if x else None
    for name, rb in VERSIONS:
        sim.X.clear(); sim.X.update(X0)
        if rb: sim.X["after_half"] = rb
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: return None
        out[name] = sim.result(cost, steps)
        out[name + "#h"] = held(cost, steps)
        out[name + "#rb"] = any(s[5] == "U_check10" for s in steps)
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
        print("| Version | Cut at 10 | Winners | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Trades changed, their sum vs today |\n|---|---|---|---|---|---|---|---|")
        for name, _ in VERSIONS:
            rows = [dict(date=t["date"], pnl=str(pt(R[key(t)][name])), **R[key(t)][name + "#h"]) for t in L]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            top = set(sorted(range(len(rows)), key=lambda k: -float(rows[k]["pnl"]))[:5])
            a5, _ = account([r for k, r in enumerate(rows) if k not in top])
            yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            ch = [t for t in L if abs(R[key(t)][name] - R[key(t)][base]) > 1e-9]
            diff = sum(pt(R[key(t)][name]) - pt(R[key(t)][base]) for t in ch)
            win = sum(R[key(t)][name] > 0 for t in L)
            nrb = sum(R[key(t)].get(name + "#rb", False) for t in L)
            print(f"| {name} | {nrb} | {win} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {len(ch)}, {diff:+,.0f} |")
        for main_v, _ in VERSIONS[1:]:
            ch = sorted(((pt(R[key(t)][main_v]) - pt(R[key(t)][base]), t["sym"], t["date"]) for t in L if abs(R[key(t)][main_v] - R[key(t)][base]) > 1e-9), reverse=True)
            print(f"\n{main_v}: biggest gains", [(s, d, f"{x:+,.0f}") for x, s, d in ch[:5]], "biggest losses", [(s, d, f"{x:+,.0f}") for x, s, d in ch[-5:]])


if __name__ == "__main__":
    main()
