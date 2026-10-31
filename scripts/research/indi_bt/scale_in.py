"""V2: scaling in. Half the size at the signal, the other half within 1-5 minutes if the trade goes our way; if it does
not, the trade stays at half. Both halves are the same contract and each runs the champion's exits from its own entry
(your stop from its own entry price, the overnight hold). On the V1 trades (191 stocks, delta 0.15); the news filter
and the lists are applied in the summary, 1% of the current account from $100,000.

  A  add at the first minute 1-5 the stock is our way vs the signal price
  B  add at the first minute 1-5 the stock is 0.2% or more our way
  C  add at the first minute 1-5 the option closes 20% or more over the first half's cost
  D  add at minute 5 only, if the stock is our way then

  python3 scale_in.py      (from the repo root, BT_UNIVERSE=wide)
"""
import csv, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from signals import series
from tiers_round import H, NIGHT
import news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account, held

B = "data/local/x/bt"
PREFIX = (sys.argv[1:] or ["w_flat_n100"])[0]  # the trades to scale in (default: the C signal at t >= 2)
CAL = calendar()
sim.X.update(dict(H, **NIGHT))


def add_minute(t, rule, cost):
    m, bet = int(t["minute"]), 1 if t["right"] == "C" else -1
    c = series(day(t["sym"], t["date"]))[0]
    opt = {b[0]: b[4] for b in day(t["contract"], t["date"])}
    s0 = c[m]
    for k in range(1, 6):
        x = c[min(m + k, 389)]
        if x is None or not s0: continue
        move = bet * (x / s0 - 1) * 100
        if rule == "A" and move > 0: return m + k
        if rule == "B" and move >= 0.2: return m + k
        if rule == "C" and opt.get(m + k, 0) >= cost * 1.2: return m + k
        if rule == "D" and k == 5 and move > 0: return m + k
    return None


def mix(parts):
    """account()'s booking of legs [(held() dict, result, weight)] closed as one trade, on the last leg's sale day."""
    fin = lambda h, x, d: h["marks"].get(d, max(-1, x) if d >= h["exit_day"] else 0.0)
    days = set().union(*(h["marks"] for h, _, _ in parts))
    return dict(exit_day=max(h["exit_day"] for h, _, _ in parts),
                marks={d: sum(w * fin(h, x, d) for h, x, w in parts) for d in days})


def run(t):
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
    if cost is None: return None
    r1 = sim.result(cost, steps)
    out = dict(key=(t["date"], t["sym"], t["minute"]), r1=r1, h1=held(cost, steps))
    for rule in "ABCD":
        am = add_minute(t, rule, cost)
        r2, out[rule + "#h"] = None, None
        if am is not None:
            c2, s2, _ = sim.walk(t["sym"], t["date"], am, t["right"], t["contract"], t["expiry"], CAL)
            if c2 is not None: r2, out[rule + "#h"] = sim.result(c2, s2), held(c2, s2)
        out[rule] = r2
    return out


def main():
    T = sorted((t for f in glob.glob(f"{B}/{PREFIX}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
               key=lambda t: (t["date"], int(t["minute"])))
    nf.features(T)
    with mp.Pool(6) as pool: R = {r["key"]: r for r in pool.map(run, T, chunksize=10) if r}
    news = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
    lists = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)]
    for lname, lf in lists:
        L = [t for t in T if lf(t) and news(t) and (t["date"], t["sym"], t["minute"]) in R]
        print(f"\n### champion trades, {lname}: {len(L)}\n")
        print("| Version | Added | Per trade 2024 / 2025 / 2026 | Avg size used | At 1% | At 2% |\n|---|---|---|---|---|---|")
        for lab, rule in (("full size at the signal (champion)", None), ("half size only", "half"), ("A: add when the stock is our way, 1-5 min", "A"),
                          ("B: add when 0.2%+ our way, 1-5 min", "B"), ("C: add when the option is +20%, 1-5 min", "C"), ("D: add at 5 min if our way", "D")):
            rows = []
            for t in L:
                r = R[(t["date"], t["sym"], t["minute"])]
                legs = [(r["h1"], r["r1"], 1.0)]
                if rule is None: pnl, used = float(t["pnl"]), 1.0
                elif rule == "half": pnl, used = 0.5e4 * max(-1, r["r1"]), 0.5; legs = [(r["h1"], r["r1"], 0.5)]
                else:
                    r2 = r[rule]
                    pnl = 0.5e4 * max(-1, r["r1"]) + (0.5e4 * max(-1, r2) if r2 is not None else 0)
                    used = 1.0 if r2 is not None else 0.5
                    legs = [(r["h1"], r["r1"], 0.5)] + ([(r[rule + "#h"], r2, 0.5)] if r2 is not None else [])
                rows.append(dict(t, pnl=str(pnl), _used=used, **mix(legs)))
            yr = [[float(x["pnl"]) for x in rows if x["date"][:4] == y] for y in ("2024", "2025", "2026")]
            added = sum(x["_used"] == 1.0 for x in rows) if rule not in (None, "half") else ""
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            print(f"| {lab} | {added} | " + " / ".join(f"{st.fmean(v):+,.0f}" for v in yr) + f" | {st.fmean(x['_used'] for x in rows):.0%} | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |")


if __name__ == "__main__":
    main()
