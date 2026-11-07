"""Reads indi_choice_iv.py's iv.json: his pick's percentile among the list names the same night (all, and calm ATR < 3.6%)
on iv, ivrv, side_ivrv (his side's 0.15-delta IV / realized vol), rs_day; tune / check. Then every list name by fifth
of ivrv: share of nights 2%+ his way / 2%+ against (15:57 -> 09:45)."""
import json, sys, collections, statistics as st
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from split import half
X = [r for r in json.load(open(sys.argv[1])) if r["on"] is not None and r["ivrv"]]
for r in X: r["side_ivrv"] = r["his_iv"] / r["rv"] if r["his_iv"] and r["rv"] else None
for r in X: r["cheap"] = -r["ivrv"]
M = ["ivrv", "side_ivrv", "iv", "rs_day"]
night = collections.defaultdict(list)
for r in X: night[r["date"]].append(r)
print(len(X), "rows,", len(night), "nights,", sum(r["his"] for r in X), "his picks on the list")
for label, ok in (("all list names", lambda r: True), ("calm (ATR < 3.6%)", lambda r: r["atr_pct"] and r["atr_pct"] < 3.6)):
    P = {h: collections.defaultdict(list) for h in ("tune", "check")}; n = collections.Counter()
    for d, rs in night.items():
        rs = [r for r in rs if ok(r)]; me = [r for r in rs if r["his"]]
        if not me or len(rs) < 5: continue
        me = me[0]; h = half(d); n[h] += 1
        for k in M:
            v = [r[k] for r in rs if not r["his"] and r.get(k) is not None]
            if me.get(k) is None or not v: continue
            P[h][k].append(100 * (sum(a < me[k] for a in v) + .5 * sum(a == me[k] for a in v)) / len(v))
    print(f"\nHis pick's percentile, {label} (low = cheaper / lower than the others)  nights {dict(n)}")
    for k in M: print(f"  {k:10} tune {st.mean(P['tune'][k]):4.0f} (n{len(P['tune'][k])})   check {st.mean(P['check'][k]):4.0f} (n{len(P['check'][k])})")
    his = [r for r in X if r["his"] and ok(r)]
    print(f"  his picks: median ivrv {st.median(r['ivrv'] for r in his):.2f} vs others {st.median(r['ivrv'] for r in X if not r['his'] and ok(r)):.2f}")
print("\nEvery list name, by fifth of ivrv (q1 = cheapest): 2%+ his way / 2%+ against, %")
for label, ok in (("all", lambda r: True), ("calm", lambda r: r["atr_pct"] and r["atr_pct"] < 3.6)):
    for h in ("tune", "check"):
        P = sorted([r for r in X if half(r["date"]) == h and ok(r) and not r["his"]], key=lambda r: r["ivrv"]); q = len(P) // 5
        G = [P[j * q:(j + 1) * q if j < 4 else len(P)] for j in range(5)]
        print(f"  {label:4} {h:5} " + " | ".join(f"q{j+1} {100*sum(r['on']>=.02 for r in g)/len(g):4.1f}/{100*sum(r['on']<=-.02 for r in g)/len(g):4.1f}" for j, g in enumerate(G)) + f"  n{len(P)}  ivrv cuts " + " ".join(f"{g[-1]['ivrv']:.2f}" for g in G[:4]))
