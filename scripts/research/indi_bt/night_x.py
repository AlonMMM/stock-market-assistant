"""V2: stops and profit taking on the carried days (the user's idea, 2026-10-23). After a big first day the next day
can be big too, but with profit taking during it, and the first 30 minutes can be wild. The champion on a carried day:
nothing before 09:40, the morning gap rule at 09:40 (half or all), then only -30% from the price paid.

Both versions measure from the option's price at the last 15:50 hold ("last night's price") and keep every champion
rule (gap rule, -30% from cost, 15:50 decision, expiry); set before running, not tuned:
  A  from 09:40: sell all at -30% under last night's price; sell half of what is left at +50% over it; after that
     the rest is sold if it falls back to last night's price
  B  A from the first minute (09:31): in the first 30 minutes the stop is wider, -40% under last night's price;
     the take profit works from 09:31 too

Same trades (t >= 1.8, news filter, delta 0.15), each walked again; 1% / 2% of the start-of-day account from $100,000.
Also split by the first day's gain at the hold (+100-300% / +300% and more).

  python3 night_x.py      (from the repo root)
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
NA = dict(**{"from": 10}, stop=-0.30, take=0.50, take_share=0.5, after_take=0.0)
NB = {**NA, "from": 1, "early_until": 30, "early_stop": -0.40}
VERSIONS = [("Champion", None), ("A: stop + take profit from 16:40", NA), ("B: A + first 30 minutes", NB)]


def walk(t):
    out = {}
    for lab, nx in VERSIONS:
        sim.X.clear(); sim.X.update(X0 if nx is None else {**X0, "night_x": nx})
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: out[lab] = None; continue
        carry = next((s for s in steps if s[2] == "carry"), None)
        first = None if carry is None else carry[4] / cost - 1
        out[lab] = (sim.result(cost, steps), first, sorted({s[5] for s in steps if s[5].startswith("NX_")}),
                   booked(cost, steps))
    return (t["date"], t["sym"], t["minute"]), out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(pool.map(walk, T, chunksize=10))
    key = lambda t: (t["date"], t["sym"], t["minute"])
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and all(R[key(t)][lab] for lab, _ in VERSIONS)]
        held = [t for t in L if R[key(t)]["Champion"][1] is not None]
        print(f"\n### {lname}: {len(L)} trades, {len(held)} held overnight\n")
        print("| Version | Per trade 2024 / 2025 / 2026 | At 1% | At 2% | Held trades: sum of returns, +100-300% / +300%+ |\n|---|---|---|---|---|")
        for lab, _ in VERSIONS:
            rows = [dict(t, pnl=str(1e4 * max(-1, R[key(t)][lab][0])), **R[key(t)][lab][3]) for t in L]
            yr = [[float(x["pnl"]) for x in rows if x["date"][:4] == y] for y in ("2024", "2025", "2026")]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            small = sum(R[key(t)][lab][0] for t in held if R[key(t)]["Champion"][1] < 3)
            big = sum(R[key(t)][lab][0] for t in held if R[key(t)]["Champion"][1] >= 3)
            print(f"| {lab} | " + " / ".join(f"{st.fmean(v):+,.0f}" for v in yr) + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% | {100 * small:+,.0f} / {100 * big:+,.0f} points |", flush=True)
        for lab, _ in VERSIONS[1:]:
            rules = {}
            for t in held:
                for r in R[key(t)][lab][2]: rules[r] = rules.get(r, 0) + 1
            diffs = sorted(((R[key(t)][lab][0] - R[key(t)]["Champion"][0], t) for t in held), key=lambda x: x[0])
            print(f"\n{lab}: rules fired {rules}; changed {sum(abs(d) > 1e-9 for d, _ in diffs)} of {len(held)}")
            print("  most hurt:", [(t["date"], t["sym"], t["right"], f"{d:+.0%}") for d, t in diffs[:5]])
            print("  most helped:", [(t["date"], t["sym"], t["right"], f"{d:+.0%}") for d, t in diffs[-5:]])


if __name__ == "__main__":
    main()
