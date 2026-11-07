"""Diagnostic (the user, 2026-11-07: "what do you think making the edge for the overnight?"). Every late trade of
late_reset.py's broadest H version (Hn715-a-x: t >= 0.5, the stock 70%+ of the day's range for 15 minutes, 15:30+,
held overnight) with its features and what the stock did: the rest of the day, the gap to the next open, the next
morning. Tune and check side by side; no level is picked here.
-> <out>/late_legs_features.csv
"""
import csv, collections, datetime as dt, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import news_filter as nf
import thin_strike as TS
from store import day
from split import half
CAL = TS.CAL
B = "data/local/x/bt"
V = os.environ.get("OE_V", "Hn715-a-x")

def px(sym, d, m):
    bars = {b[0]: b for b in day(sym, d)}
    for k in range(m, -1, -1):
        if k in bars: return bars[k][4]
    return None

def first(sym, d, m0=0, m1=30):
    bars = sorted((b for b in day(sym, d) if m0 <= b[0] <= m1), key=lambda b: b[0])
    return bars

legs = [r for r in csv.DictReader(open(f"{B}/late_reset_legs.csv")) if r["version"] == V]
sig = {}
for f in sorted(os.listdir(B)):
    if f.startswith("s_late_t05_20"):
        for r in csv.DictReader(open(f"{B}/{f}")): sig[(r["sym"], r["date"], r["right"], r["minute"])] = r
nf.features(legs)
out = []
for r in legs:
    s, d, m, bet = r["sym"], r["date"], int(r["minute"]), 1 if r["right"] == "C" else -1
    i = CAL.index(d); n = CAL[i + 1]
    e, c = px(s, d, m), px(s, d, 389); se, sc = px("SPY", d, m), px("SPY", d, 389)
    o = first(s, n, 0, 0); so = first("SPY", n, 0, 0)
    h30 = first(s, n, 0, 30)
    o0 = px(s, d, 0); prev = px(s, CAL[i - 1], 389)
    if not all([e, c, o, h30, o0, prev, se, sc, so]): continue
    nopen = o[0][1]; sopen = so[0][1]
    best30 = max(b[2] for b in h30) if bet > 0 else min(b[3] for b in h30)
    g = sig.get((s, d, r["right"], r["minute"]), {})
    bars = [b for b in day(s, d) if b[0] <= m]; hi, lo = max(b[2] for b in bars), min(b[3] for b in bars)
    out.append(dict(part=r["part"], list=r["list"], date=d, wd=dt.date.fromisoformat(d).strftime("%a"), minute=m, sym=s,
        right=r["right"], contract=r["contract"], opt_price=r["price"], vol30=r["vol30"], usd10k=int(r["usd10k"]),
        t=g.get("c_t"), d2=g.get("c_e"), rvol=g.get("c_rvol"), rv30=g.get("c_rv30"),
        day_move=round(bet * (e / o0 - 1) * 100, 2), from_prev=round(bet * (e / prev - 1) * 100, 2),
        range_pct=round(100 * bet * (hi - lo) / lo, 2) if bet > 0 else round(100 * (hi - lo) / lo, 2),
        rest_of_day=round(bet * (c / e - 1) * 100, 2), gap=round(bet * (nopen / c - 1) * 100, 2),
        spy_gap=round(bet * (sopen / sc - 1) * 100, 2), spy_day=round(bet * (sc / px("SPY", d, 0) - 1) * 100, 2) if px("SPY", d, 0) else None,
        best_30min=round(bet * (best30 / c - 1) * 100, 2), earn_tonight=int(r["e_next"] == 1),
        earn_last=r["e_last"], pre_rvol=None if r["pre_rvol"] is None else round(r["pre_rvol"], 2)))
o = sys.argv[1]
with open(f"{o}/late_legs_features.csv", "w") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
print(len(out), "of", len(legs), "legs")
