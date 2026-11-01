"""Where the losses come from: main legs of one run, cut by spread, price, entry time, side, stock, month (at $10K a trade, r2)."""
import csv, sys, collections, statistics as st
y, tag = sys.argv[1], sys.argv[2]
T = [r for r in csv.DictReader(open(f"data/local/x/bt/y{y}/trades{tag}.csv")) if r["kind"] == "main" and r["news_ok"] == "1" and r["contract"]]
for r in T: r["u"] = 1e4 * max(-1, float(r["r2"])); r["g"] = float(r["r2"]) >= 3
def show(name, key, order=None):
    G = collections.defaultdict(list)
    for r in T: G[key(r)].append(r)
    ks = order or sorted(G, key=lambda k: sum(r["u"] for r in G[k]))
    print(f"\n{name}:  group | trades | sum | giants | non-giant sum | median")
    for k in ks:
        g = G.get(k, [])
        if not g: continue
        print(f"  {k} | {len(g)} | {sum(r['u'] for r in g):+,.0f} | {sum(r['g'] for r in g)} | {sum(r['u'] for r in g if not r['g']):+,.0f} | {st.median(r['u'] for r in g):+,.0f}")
def sb(r):
    s = r.get("spread"); s = float(s) if s not in ("", None) else None
    if s is None: return "?"
    for c, n in ((0.05, "a <5%"), (0.10, "b 5-10%"), (0.15, "c 10-15%"), (0.20, "d 15-20%"), (0.30, "e 20-30%")):
        if s < c: return n
    return "f 30%+"
print(f"{y}{tag}: {len(T)} main legs, sum {sum(r['u'] for r in T):+,.0f}, giants {sum(r['g'] for r in T)}")
show("entry spread", sb, sorted({sb(r) for r in T}))
show("contract price", lambda r: next(n for c, n in ((0.30, "a $0.20-0.30"), (0.50, "b $0.30-0.50"), (1.0, "c $0.50-1"), (9e9, "d $1+")) if float(r["cost"]) < c), ["a $0.20-0.30", "b $0.30-0.50", "c $0.50-1", "d $1+"])
show("entry minute", lambda r: next(n for c, n in ((5, "a 0-4"), (10, "b 5-9"), (15, "c 10-14"), (999, "d 15+")) if int(r["minute"]) < c), ["a 0-4", "b 5-9", "c 10-14", "d 15+"])
show("side", lambda r: r["right"]); show("D2", lambda r: r["d2"])
show("month", lambda r: r["date"][:7], sorted({r["date"][:7] for r in T}))
G = collections.defaultdict(list)
for r in T: G[r["sym"]].append(r["u"])
w = sorted(G.items(), key=lambda kv: sum(kv[1]))
print("\nworst 10 stocks:", ", ".join(f"{k} {len(v)}x {sum(v):+,.0f}" for k, v in w[:10]))
print("best 5 stocks:", ", ".join(f"{k} {len(v)}x {sum(v):+,.0f}" for k, v in w[-5:][::-1]))
L = [r["u"] for r in T if r["u"] < 0]
print(f"\nlosers: {len(L)} of {len(T)}, sum {sum(L):+,.0f}; lost 80%+ of the premium: {sum(u <= -8000 for u in L)} ({sum(u for u in L if u <= -8000):+,.0f}); lost 30-80%: {sum(-8000 < u <= -3000 for u in L)} ({sum(u for u in L if -8000 < u <= -3000):+,.0f}); lost <30%: {sum(u > -3000 for u in L)} ({sum(u for u in L if u > -3000):+,.0f})")
