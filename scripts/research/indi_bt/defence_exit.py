"""An exit for the D2 bonus entry that matches its idea (the user, 2026-10-25: "D2 helps us enter faster, but nothing
helps us avoid losses like before"; the failed break fails with D2, d2_failed_break.py). D2 enters because the stock
held up on SPY's bad minutes; the exit is when that stops: on the entry day, from `window` minutes after the entry, the
D2 of the last `window` minutes is `out` or under -> sell all (sim: defence). Set before running: main cell 15 minutes
at 0; neighbours 15 at -0.5 and -1, 30 at 0, to see a ridge or a spike. On the D2 champion (sg_c12_15, the rest-stop
exits); fair list and 151 unseen; 1% / 2% from $100,000.

  python3 ../sma-indi-backtest/scripts/research/indi_bt/defence_exit.py      (from the repo root)
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

B = "data/local/x/bt"
CAL = calendar()
CHAMP = {**sim.X, **H, **NIGHT, "thesis": {"t": 0.5}, "carry_min_gain": 0.5, "after_half": dict(out=-0.2)}
VERSIONS = [("D2 champion", CHAMP), ("+ defence 15 min <= 0", {**CHAMP, "defence": dict(window=15, out=0.0)}),
            ("+ defence 15 min <= -0.5", {**CHAMP, "defence": dict(window=15, out=-0.5)}),
            ("+ defence 15 min <= -1", {**CHAMP, "defence": dict(window=15, out=-1.0)}),
            ("+ defence 30 min <= 0", {**CHAMP, "defence": dict(window=30, out=0.0)})]


def one(t):
    out = {}
    for name, rb in VERSIONS:
        sim.X.clear(); sim.X.update(rb)
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: return None
        out[name] = sim.result(cost, steps)
        out[name + "#h"] = held(cost, steps)
        out[name + "#df"] = any(s[5] == "DF_defence" for s in steps)
    return (t["date"], t["sym"], t["minute"]), out


def main():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(r for r in pool.map(one, T, chunksize=8) if r)
    key = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    base = VERSIONS[0][0]
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and key(t) in R]
        print(f"\n### {lname}: {len(L)} trades\n")
        print("| Version | Defence sales | Winners | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Trades changed, their sum |\n|---|---|---|---|---|---|---|---|")
        for name, _ in VERSIONS:
            rows = [dict(date=t["date"], pnl=str(pt(R[key(t)][name])), **R[key(t)][name + "#h"]) for t in L]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            top = set(sorted(range(len(rows)), key=lambda k: -float(rows[k]["pnl"]))[:5])
            a5, _ = account([r for k, r in enumerate(rows) if k not in top])
            yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            ch = [t for t in L if abs(R[key(t)][name] - R[key(t)][base]) > 1e-9]
            diff = sum(pt(R[key(t)][name]) - pt(R[key(t)][base]) for t in ch)
            nd = sum(R[key(t)][name + "#df"] for t in L)
            win = sum(R[key(t)][name] > 0 for t in L)
            print(f"| {name} | {nd} | {win} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {len(ch)}, {diff:+,.0f} |", flush=True)
        main_v = VERSIONS[1][0]
        ch = sorted(((pt(R[key(t)][main_v]) - pt(R[key(t)][base]), t["sym"], t["date"]) for t in L if abs(R[key(t)][main_v] - R[key(t)][base]) > 1e-9), reverse=True)
        print(f"\n{main_v}: saved on losers {sum(x for x, *_ in ch if x > 0):+,.0f}, lost on others {sum(x for x, *_ in ch if x < 0):+,.0f}; biggest gains",
              [(s, d, f"{x:+,.0f}") for x, s, d in ch[:5]], "biggest losses", [(s, d, f"{x:+,.0f}") for x, s, d in ch[-5:]])


if __name__ == "__main__":
    main()
