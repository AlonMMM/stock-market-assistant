"""A rule shaped like his calm choice, on EVERY night (not only his): does it find his kind of night? Stock only."""
import csv, gzip, json, bisect, math, sqlite3, statistics as st, sys, collections, datetime as dt
sys.path.insert(0, "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
from split import half
A = "/Users/alonmo/Desktop/Personal/stock-market-assistant/data/local/x/bt/"
N = json.load(open(A + "indi_nights.json"))
his = {(n["sym"], n["date"], n["right"]) for n in N}
hist = collections.defaultdict(list)
for n in N: hist[n["sym"]].append(n["date"])
rows = []
with gzip.open(A + "nightly_feat.csv.gz", "rt") as fh:
    for x in csv.DictReader(fh):
        if x["earn"] != "0" or x["on"] in ("", None) or x["date"] < "2024-02-01": continue
        if dt.date.fromisoformat(x["date"]).weekday() == 4: continue
        r = {k: float(x[k]) if x[k] not in ("", None) else None for k in ("rs_day","t","pos","vwap_ext","dollar","on")}
        r.update(sym=x["sym"], date=x["date"], side=x["side"]); rows.append(r)
db = sqlite3.connect(A + "daily_all.sqlite"); D = {}
def daily(s):
    if s not in D:
        b = db.execute("select date,h,l,c from day where symbol=? order by date", (s,)).fetchall(); D[s] = (b, [r[0] for r in b])
    return D[s]
def atr_brk(sym, date, side):
    b, ds = daily(sym); i = bisect.bisect_left(ds, date)
    if i >= len(ds) or ds[i] != date or i < 21: return None, None
    tr = [max(b[k][1], b[k-1][3]) - min(b[k][2], b[k-1][3]) for k in range(i-14, i)]; atr = st.mean(tr)
    c = b[i][3]
    hi, lo = max(r[1] for r in b[i-20:i]), min(r[2] for r in b[i-20:i])
    return atr / c * 100, ((c - hi) if side == "C" else (lo - c)) / atr
for r in rows: r["atr"], r["brk20"] = atr_brk(r["sym"], r["date"], r["side"])
rows = [r for r in rows if r["atr"] is not None]
night = collections.defaultdict(list)
for r in rows: night[(r["date"], r["side"])].append(r)
def tag(L):
    calm = [r for r in L if r["atr"] < 3.6]
    dol = sorted([r["dollar"] for r in L if r["dollar"] is not None], reverse=True)
    top_d = dol[9] if len(dol) >= 10 else 0
    rsc = sorted([r["rs_day"] for r in calm if r["rs_day"] is not None])
    top_rs = rsc[int(0.8 * len(rsc))] if rsc else 99
    for r in L:
        r["calm"] = r["atr"] < 3.6
        r["big"] = r["dollar"] is not None and r["dollar"] >= top_d
        r["strong"] = r["rs_day"] is not None and r["rs_day"] >= top_rs
        r["brk"] = r["brk20"] is not None and r["brk20"] > 0
        r["high"] = r["pos"] is not None and r["pos"] >= 0.85 and (r["vwap_ext"] or 0) > 0
        r["usual"] = sum(d < r["date"] for d in hist[r["sym"]]) >= 3
        r["his"] = (r["sym"], r["date"], r["side"]) in his
for L in night.values(): tag(L)
V = {
 "every calm name": lambda r: r["calm"],
 "calm + big": lambda r: r["calm"] and r["big"],
 "calm + big + strong": lambda r: r["calm"] and r["big"] and r["strong"],
 "calm + big + strong + 20d break + high": lambda r: r["calm"] and r["big"] and r["strong"] and r["brk"] and r["high"],
 "calm + strong + 20d break + high": lambda r: r["calm"] and r["strong"] and r["brk"] and r["high"],
 "same + his usual names": lambda r: r["calm"] and r["big"] and r["strong"] and r["brk"] and r["high"] and r["usual"],
 "his usual names, calm + strong": lambda r: r["calm"] and r["strong"] and r["usual"],
 "HIS OWN calm picks": lambda r: r["calm"] and r["his"],
}
print("stock 15:57 -> 09:45 on the bet's side; every Mon-Thu night Feb 2024 on, top 50, no earnings")
for v, f in V.items():
    out = []
    for p in ("tune", "check"):
        g = [r for r in rows if half(r["date"]) == p and f(r)]
        mv = [100 * r["on"] for r in g]
        if not mv: out.append("-"); continue
        caught = sum(r["his"] for r in g)
        out.append(f"n{len(g):5d} 2%+ {100*sum(m>=2 for m in mv)/len(mv):4.1f}% 4%+ {100*sum(m>=4 for m in mv)/len(mv):3.1f}% against2% {100*sum(m<=-2 for m in mv)/len(mv):4.1f}% mean {st.mean(mv):+.2f}% his {caught}")
    print(f"{v:40s} {out[0]}  ||  {out[1]}")
