"""His choice as a combination (the user 2026-11-07: "its obv a combination. Stock should be strong against spy for sure
And close higher than her last x days hight (some resistance that might become support)"). Every Mon-Thu night Feb 2024
- Oct 2026, the list (strangle_rank top 50, HIMS out, + GLD + APP), no earnings night (nightly_feat earn 0), both sides,
at 15:57: strong = rs_day (vs beta x SPY + sector, z, his side) >= 1 / >= 2; break X = the 15:57 price above the
previous X days' highest high (calls; below the lowest low for puts), X = 5 / 10 / 20 / none; calm = ATR(14) < 3.6%.
Levels set before the run. Per version and half: name-nights, 2%+ his way / against (15:57 -> 09:45), the median move,
and how many of his own picks (indi_nights.json) it holds."""
import csv, gzip, json, sqlite3, statistics as st, sys, datetime as dt, collections
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from split import half
A = "/Users/alonmo/Desktop/Personal/stock-market-assistant/data/local/x/bt/"
LIST = set([s for s in json.load(open(__file__.rsplit("/", 1)[0] + "/strangle_rank.json"))[:50] if s != "HIMS"] + ["GLD", "APP"])
HIS = {(n["date"], n["sym"], n["right"]) for n in json.load(open(A + "indi_nights.json"))}
ddb = sqlite3.connect(A + "daily_all.sqlite"); mdb = sqlite3.connect(A + "market.sqlite")
D = {s: ddb.execute("select date,h,l,c from day where symbol=? order by date", (s,)).fetchall() for s in LIST}
IX = {s: {r[0]: i for i, r in enumerate(v)} for s, v in D.items()}
def px387(s, d):
    r = mdb.execute("select bars from bars where symbol=? and date=?", (s, d)).fetchone()
    a = json.loads(r[0]) if r else []
    b = [x for x in a if x[0] <= 387]
    if not b or b[-1][0] < 382: return None
    return b[-1][4] / a[-1][4] * D[s][IX[s][d]][3]   # in the daily table's (split-adjusted) prices: x its close / the raw close
rows = []
with gzip.open(A + "nightly_feat.csv.gz", "rt") as fh:
    for x in csv.DictReader(fh):
        s, d = x["sym"], x["date"]
        if s not in LIST or x["earn"] != "0" or x["on"] == "" or x["rs_day"] == "" or dt.date.fromisoformat(d).weekday() > 3: continue
        if d not in IX[s] or IX[s][d] < 25: continue
        rows.append(x)
pxc = {}
out = []
for x in rows:
    s, d, side = x["sym"], x["date"], x["side"]
    if (s, d) not in pxc: pxc[(s, d)] = px387(s, d)
    p = pxc[(s, d)]
    if p is None: continue
    i = IX[s][d]; P = D[s][i - 20:i]
    tr = [max(P[k][1], P[k - 1][3]) - min(P[k][2], P[k - 1][3]) for k in range(len(P) - 14, len(P))]
    r = dict(sym=s, date=d, side=side, rs=float(x["rs_day"]), on=float(x["on"]), atr=st.mean(tr) / p * 100, his=(d, s, side) in HIS)
    for X in (5, 10, 20):
        r[f"b{X}"] = p > max(q[1] for q in P[-X:]) if side == "C" else p < min(q[2] for q in P[-X:])
    out.append(r)
H = {h: sum(1 for r in out if r["his"] and half(r["date"]) == h) for h in ("tune", "check")}
Hc = {h: sum(1 for r in out if r["his"] and r["atr"] < 3.6 and half(r["date"]) == h) for h in ("tune", "check")}
print(len(out), "name-night-sides;", "his picks on the list (no earnings, Mon-Thu):", H, " calm:", Hc)
def line(name, g):
    cells = []
    for h in ("tune", "check"):
        x = [r for r in out if half(r["date"]) == h and g(r)]
        if not x: cells.append(" " * 44); continue
        up = 100 * sum(r["on"] >= .02 for r in x) / len(x); dn = 100 * sum(r["on"] <= -.02 for r in x) / len(x)
        hs = sum(r["his"] for r in x)
        cells.append(f"{len(x):6d} {up:5.1f} / {dn:4.1f}  med {100*st.median(r['on'] for r in x):+5.2f}%  his {hs:3d}")
    print(f"{name:28} " + " | ".join(cells))
print(f"{'version':28} {'tune: n  2%+ his way / against  median  his picks':47} | check")
for calm in (False, True):
    for rs in (None, 1, 2):
        for X in (None, 5, 10, 20):
            def g(r, calm=calm, rs=rs, X=X):
                return (not calm or r["atr"] < 3.6) and (rs is None or r["rs"] >= rs) and (X is None or r[f"b{X}"])
            line(f"{'calm ' if calm else ''}{'rs>=' + str(rs) if rs else 'any rs'}{' + break ' + str(X) if X else ''}", g)
    print()
line("his picks (all)", lambda r: r["his"])
line("his picks (calm)", lambda r: r["his"] and r["atr"] < 3.6)
json.dump(out, open(sys.argv[1], "w"))
