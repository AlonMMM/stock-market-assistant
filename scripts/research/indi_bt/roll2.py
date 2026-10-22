"""V2: rolling again, on the champion (t >= 1.8, news filter, delta 0.15, your stop + overnight hold).

  trigger  on the entry day, the stock has covered (1 - near) of the way from the entry price to the strike, within
           `frac` of the trading time the contract had left at entry ("fast" scales with the time to expiry:
           a 1DTE contract has ~1-2 sessions, a 4DTE one ~4-5)
  roll     sell `share` of the contract (next bar, middle - 2%) and buy the delta 0.30 contract of the nearest expiry
           1-7 days out at that minute; the rest of the first contract stays under the champion's exits
  funding  "cost": the roll gets what the sold part cost (its profit is banked);
           "proceeds": the roll gets everything the sold part brought in
  The roll contract runs the champion's exits from its own entry and does not roll again.

  node --env-file=.env scripts/research/indi_bt/run.mjs roll2.py      (from the repo root)
"""
import csv, glob, itertools, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from tiers_round import H, NIGHT
import news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = calendar(); IX = {d: i for i, d in enumerate(CAL)}
X0 = {**sim.X, **H, **NIGHT}
NEARS, FRACS, SHARES, FUNDS = (0.5, 0.25), (0.1, 0.25), (0.25, 0.5), ("cost", "proceeds")


def left_minutes(date, minute, exp):
    """Trading minutes from the entry to the expiry close."""
    return (IX[exp] - IX[date]) * 390 + 390 - minute


def run(t):
    sim.X.clear(); sim.X.update(X0)
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
    if cost is None: return None
    out = dict(key=(t["date"], t["sym"], t["minute"]), base=sim.result(cost, steps))
    if t["expiry"] not in IX: return out
    lm = left_minutes(t["date"], int(t["minute"]), t["expiry"])
    for near, frac, share in itertools.product(NEARS, FRACS, SHARES):
        sim.X.clear(); sim.X.update(X0, roll=dict(near=near, within=frac * lm, share=share, rest_take=99))
        c1, s1, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        r = next((s for s in s1 if s[5] == "R_roll"), None)
        if not r: continue
        first = sim.result(c1, s1)
        spot = [x for x in day(t["sym"], r[0]) if x[0] <= r[1]]
        roll = None
        if spot:
            sim.X.clear(); sim.X.update(X0)
            old = sim.C["delta"]; sim.C["delta"] = 0.30
            rp, _ = sim.pick(t["sym"], r[0], r[1], t["right"], spot[-1][4])
            sim.C["delta"] = old
            if rp:
                c2, s2, _ = sim.walk(t["sym"], r[0], r[1], t["right"], rp[0], rp[1], CAL)
                if c2 is not None: roll = sim.result(c2, s2)
        out[(near, frac, share)] = (first, r[3], r[4] / c1, roll)
    return out


def main():
    T = sorted((t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
               key=lambda t: (t["date"], int(t["minute"])))
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    with mp.Pool(6) as pool: R = {r["key"]: r for r in pool.map(run, T, chunksize=10) if r}
    lists = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)]
    for lname, lf in lists:
        L = [t for t in T if lf(t) and (t["date"], t["sym"], t["minute"]) in R]
        print(f"\n### {lname}: {len(L)} trades\n")
        print("| Version | Rolled | Rolled trades $ (champion -> roll) | 2024 / 2025 / 2026 per trade | Without best 5 (24 / 25 / 26) | At 1% | At 2% |\n|---|---|---|---|---|---|---|")
        for v in [None] + list(itertools.product(NEARS, FRACS, SHARES, FUNDS)):
            rows, n, b0, b1 = [], 0, 0.0, 0.0
            for t in L:
                r = R[(t["date"], t["sym"], t["minute"])]
                pnl = r["base"] * 1e4
                x = r.get(v[:3]) if v else None
                if x:
                    first, sold, px, roll = x
                    fund = 1e4 * sold * (px if v[3] == "proceeds" else 1.0)
                    new = first * 1e4 + (fund * max(-1, roll) if roll is not None else 0)
                    n += roll is not None; b0 += pnl; b1 += new; pnl = new
                rows.append(dict(t, pnl=str(pnl)))
            yr = [sorted(float(x["pnl"]) for x in rows if x["date"][:4] == y) for y in ("2024", "2025", "2026")]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            lab = "champion (no roll)" if v is None else f"near {v[0]:.0%} left, within {v[1]:.0%} of the time, sell {v[2]:.0%}, fund {v[3]}"
            print(f"| {lab} | {n} | {b0:+,.0f} -> {b1:+,.0f} | " + " / ".join(f"{st.fmean(y):+,.0f}" for y in yr)
                  + " | " + " / ".join(f"{sum(y[:-5]) / 1e3:+,.0f}K" for y in yr) + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |", flush=True)


if __name__ == "__main__":
    main()
