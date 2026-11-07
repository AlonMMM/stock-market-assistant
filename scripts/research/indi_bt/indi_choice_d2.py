"""D2 in the combination (the user 2026-11-07: "Remember d2? Can you add it to the test combination too?"). For every
row of indi_choice_combo.py's output (argv[1], rewritten with the new fields): D2 as defence_signals.py (the bot's):
over a 30-minute window, the stock's excess move (stock - beta x SPY) on the SPY-down minutes (SPY-up for puts, signed
his way), / the stock's S30 (spread of its 1-minute returns over the 5 sessions before x sqrt 30); beta = 60-day daily
vs SPY. d2_last = the window ending 15:57; d2_max = the highest window 09:40-15:57. Then the table on calm names:
the combination (rs_day >= 1 + past the 10 / 20-day extreme) with D2 >= 1.5 (last / any time), levels set before."""
import json, math, sqlite3, statistics as st, sys, collections
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from split import half
A = "/Users/alonmo/Desktop/Personal/stock-market-assistant/data/local/x/bt/"
mdb = sqlite3.connect(A + "market.sqlite"); ddb = sqlite3.connect(A + "daily_all.sqlite")
R = json.load(open(sys.argv[1]))
CAL = [r[0] for r in mdb.execute("select date from bars where symbol='SPY' order by date")]
CI = {d: i for i, d in enumerate(CAL)}
mc = {}
def closes(s, d):
    k = (s, d)
    if k not in mc:
        if len(mc) > 60000: mc.clear()
        r = mdb.execute("select bars from bars where symbol=? and date=?", k).fetchone()
        by = {b[0]: b[4] for b in json.loads(r[0])} if r else {}
        c, last = [], None
        for m in range(390): last = by.get(m, last); c.append(last)
        mc[k] = c if by else None
    return mc[k]
dc = {}
def dclose(s):
    if s not in dc: dc[s] = dict(ddb.execute("select date,c from day where symbol=?", (s,)).fetchall())
    return dc[s]
def beta(s, d):
    C, P = dclose(s), dclose("SPY"); i = CI[d]; ds = [x for x in CAL[i - 61:i] if x in C and x in P]
    a = [C[ds[k]] / C[ds[k - 1]] - 1 for k in range(1, len(ds))]; b = [P[ds[k]] / P[ds[k - 1]] - 1 for k in range(1, len(ds))]
    if len(a) < 40: return None
    mb = st.mean(b); v = sum((y - mb) ** 2 for y in b)
    return sum((x - st.mean(a)) * (y - mb) for x, y in zip(a, b)) / v if v else None
def s30(s, d):
    i = CI[d]; rr = []
    for x in CAL[i - 5:i]:
        c = closes(s, x)
        if c: rr += [c[m] / c[m - 1] - 1 for m in range(1, 390) if c[m] and c[m - 1]]
    return st.pstdev(rr) * math.sqrt(30) if len(rr) > 500 else None
cache = {}
for j, r in enumerate(R):
    k = (r["sym"], r["date"])
    if k not in cache:
        c, p = closes(*k), closes("SPY", r["date"])
        b, u = beta(*k), s30(*k)
        if not c or not p or b is None or not u: cache[k] = None
        else:
            ex = {"C": [0.0] * 390, "P": [0.0] * 390}
            for m in range(1, 388):
                if c[m] and c[m - 1] and p[m] and p[m - 1]:
                    rs, rp = c[m] / c[m - 1] - 1, p[m] / p[m - 1] - 1; x = rs - b * rp
                    if rp < 0: ex["C"][m] = x / u
                    if rp > 0: ex["P"][m] = -x / u
            out = {}
            for sd in "CP":
                w = [sum(ex[sd][m - 29:m + 1]) for m in range(30, 388)]
                out[sd] = (w[-1], max(w[10:]))   # windows ending 09:40 (m 40) .. 15:57 (m 387)
            cache[k] = out
    x = cache[k]
    r["d2_last"], r["d2_max"] = (x[r["side"]] if x else (None, None))
json.dump(R, open(sys.argv[1], "w"))
X = [r for r in R if r["atr"] < 3.6 and r["d2_last"] is not None]
print(len(X), "calm rows with D2;", "his calm picks:", {h: sum(1 for r in X if r["his"] and half(r["date"]) == h) for h in ("tune", "check")})
def line(name, g):
    cells = []
    for h in ("tune", "check"):
        x = [r for r in X if half(r["date"]) == h and g(r)]; o = [r for r in x if not r["his"]]
        if not o: cells.append("-"); continue
        cells.append(f"n{len(o):5}  {100*sum(r['on']>=.02 for r in o)/len(o):5.1f} / {100*sum(r['on']<=-.02 for r in o)/len(o):4.1f}  his {sum(r['his'] for r in x):3d}")
    print(f"  {name:34} tune {cells[0]}   | check {cells[1]}")
print("Calm names, his picks out of the rates (his = how many of his calm picks it holds): 2%+ his way / against")
line("any calm", lambda r: True)
line("D2 last 30 min >= 1.5", lambda r: r["d2_last"] >= 1.5)
line("D2 any time >= 1.5", lambda r: r["d2_max"] >= 1.5)
line("rs>=1", lambda r: r["rs"] >= 1)
line("rs>=1 + D2 last >= 1.5", lambda r: r["rs"] >= 1 and r["d2_last"] >= 1.5)
line("rs>=1 + D2 any >= 1.5", lambda r: r["rs"] >= 1 and r["d2_max"] >= 1.5)
for X_ in (10, 20):
    line(f"rs>=1 + break {X_}", lambda r: r["rs"] >= 1 and r[f"b{X_}"])
    line(f"rs>=1 + break {X_} + D2 last >= 1.5", lambda r: r["rs"] >= 1 and r[f"b{X_}"] and r["d2_last"] >= 1.5)
    line(f"rs>=1 + break {X_} + D2 any >= 1.5", lambda r: r["rs"] >= 1 and r[f"b{X_}"] and r["d2_max"] >= 1.5)
    line(f"break {X_} + D2 any >= 1.5", lambda r: r[f"b{X_}"] and r["d2_max"] >= 1.5)
print("\nHis calm picks: share meeting each part")
for h in ("tune", "check"):
    me = [r for r in X if r["his"] and half(r["date"]) == h]
    f = lambda k: 100 * sum(1 for r in me if k(r)) / len(me)
    print(f"  {h:5} n{len(me)}: rs>=1 {f(lambda r: r['rs'] >= 1):3.0f}%  break10 {f(lambda r: r['b10']):3.0f}%  D2 last>=1.5 {f(lambda r: r['d2_last'] >= 1.5):3.0f}%  D2 any>=1.5 {f(lambda r: r['d2_max'] >= 1.5):3.0f}%  all three (any) {f(lambda r: r['rs'] >= 1 and r['b10'] and r['d2_max'] >= 1.5):3.0f}%")
