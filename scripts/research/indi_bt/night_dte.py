"""V2: does the overnight hold depend on the days left to expiry and on how close the stock is to the strike at the
15:50 hold? The champion's held trades (t >= 1.8, news filter, delta 0.15) by both, then hold rules built on them.

  days left   calendar days from the hold day to expiry (1 = expires tomorrow)
  money       the stock at 15:50 vs the strike, % of the stock price, in the bet's direction: + in the money,
              - still out of the money

  python3 night_dte.py      (from the repo root)
"""
import csv, datetime as dt, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from night_rules import parts
from night_risk import run as account_run
import night_risk
from store import day
from signals import series
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"


def more(t):
    p = parts(t)
    if not p or not p["carried"]: return p
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], night_risk_cal())
    d = next(s for s in steps if s[2] == "carry")[0]
    bet = 1 if t["right"] == "C" else -1
    k = float(t["contract"][-8:]) / 1000
    s = series(day(t["sym"], d))[0][sim.X["eod_minute"]]
    p.update(days=(dt.date.fromisoformat(t["expiry"]) - dt.date.fromisoformat(d)).days, money=bet * (s - k) / s * 100 if s else 0.0,
             gain=p["cp"] / p["cost"] - 1)
    return p


_cal = None
def night_risk_cal():
    global _cal
    if _cal is None:
        from store import calendar
        _cal = calendar()
    return _cal


def table(C, key, buckets):
    print(f"\n| {key} | Held | Night win | Night per held contract: median / mean | Night $ on $10K (sum) |\n|---|---|---|---|---|")
    for lab, f in buckets:
        G = [p for p in C if f(p[key])]
        if not G: continue
        r = [p["night"] / p["cp"] - 1 for p in G]
        usd = sum(1e4 * p["held"] * (p["night"] - p["cp"]) / p["cost"] for p in G)
        print(f"| {lab} | {len(G)} | {sum(x > 0 for x in r)} | {st.median(r):+.0%} / {st.fmean(r):+.0%} | {usd:+,.0f} |")


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    with mp.Pool(6) as pool: P = sorted((p for p in pool.map(more, T, chunksize=20) if p), key=lambda p: (p["date"], p["minute"]))
    fair = lambda p: p["sym"] in HIS40 and p["sym"] in PRIOR[p["date"][:4]]
    unseen = lambda p: p["sym"] not in HIS40
    C = [p for p in P if p["carried"]]
    print(f"### held trades: {len(C)} (fair {sum(fair(p) for p in C)}, unseen {sum(unseen(p) for p in C)})")
    table(C, "days", [("1 day", lambda x: x == 1), ("2 days", lambda x: x == 2), ("3 days", lambda x: x == 3), ("4+ days", lambda x: x >= 4)])
    table(C, "money", [("OTM more than 2%", lambda x: x < -2), ("OTM 0-2%", lambda x: -2 <= x < 0), ("ITM 0-2%", lambda x: 0 <= x < 2),
                       ("ITM 2-5%", lambda x: 2 <= x < 5), ("ITM 5%+", lambda x: x >= 5)])
    print("\n| days x money | OTM | ITM 0-3% | ITM 3%+ |\n|---|---|---|---|")
    for dl, df in (("1 day", lambda x: x == 1), ("2 days", lambda x: x == 2), ("3+ days", lambda x: x >= 3)):
        cells = []
        for mf in (lambda x: x < 0, lambda x: 0 <= x < 3, lambda x: x >= 3):
            G = [p for p in C if df(p["days"]) and mf(p["money"])]
            usd = sum(1e4 * p["held"] * (p["night"] - p["cp"]) / p["cost"] for p in G)
            cells.append(f"{len(G)}, {sum(p['night'] > p['cp'] for p in G)} won, {usd / 1e3:+,.0f}K" if G else "")
        print(f"| {dl} | " + " | ".join(cells) + " |")
    rules = [("champion", lambda p: 1.0), ("no hold with 1 day left", lambda p: 0.0 if p["days"] == 1 else 1.0),
             ("half with 1 day left", lambda p: 0.5 if p["days"] == 1 else 1.0),
             ("no hold when still OTM", lambda p: 0.0 if p["money"] < 0 else 1.0),
             ("half when still OTM", lambda p: 0.5 if p["money"] < 0 else 1.0),
             ("no hold when 1 day left and OTM", lambda p: 0.0 if p["days"] == 1 and p["money"] < 0 else 1.0),
             ("half when 1 day left and OTM", lambda p: 0.5 if p["days"] == 1 and p["money"] < 0 else 1.0),
             ("half when ITM 5%+", lambda p: 0.5 if p["money"] >= 5 else 1.0)]
    for lname, lf in (("fair list", fair), ("151 unseen", unseen)):
        L = [p for p in P if lf(p)]
        print(f"\n### {lname}\n\n| Rule | At 1%: end / drop / worst night | At 2%: end / drop / worst night | 2% with the 15% cap |\n|---|---|---|---|")
        for lab, f in rules:
            Q = [dict(p, held=p["held"] * f(p)) if p["carried"] else p for p in L]
            # the held part removed is sold at 15:50: keep the full held size for the "sold" math
            for q, p in zip(Q, L):
                if p["carried"]: q["_full"] = p["held"]
            a1, d1, w1, _ = acct(Q, ("none", 0), 0.01); a2, d2, w2, _ = acct(Q, ("none", 0), 0.02); a3, d3, w3, _ = acct(Q, ("cap", 0.15), 0.02)
            print(f"| {lab} | ${a1:,.0f} / {100 * d1:.0f}% / {100 * w1:.1f}% | ${a2:,.0f} / {100 * d2:.0f}% / {100 * w2:.1f}% | ${a3:,.0f} / {100 * d3:.0f}% / {100 * w3:.1f}% |")


def acct(Q, rule, pct):
    """night_risk.run where `held` is what the rule keeps and `_full` what was held: the difference is sold at 15:50."""
    eq, cur, start, peak, dd, night = 1e5, None, 1e5, 1e5, 0.0, {}
    for p in Q:
        if p["date"] != cur:
            cur = p["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        r = p["ret"]
        if p["carried"]:
            h = night_risk.kept(p, rule, pct, start)
            r = (p["before"] + (p["_full"] - h) * p["sell_px"] + h * p["night"]) / p["cost"] - 1
            night[p["date"]] = night.get(p["date"], 0.0) + pct * h * (p["night"] - p["cp"]) / p["cost"]
        eq += pct * start * max(-1, r)
    return eq, max(dd, 1 - eq / max(peak, eq)), min(night.values(), default=0.0), 0


if __name__ == "__main__":
    main()
