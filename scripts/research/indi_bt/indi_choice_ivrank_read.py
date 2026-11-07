"""Reads ivhist.json (indi_choice_ivrank.py) with iv.json (indi_choice_iv.py: his nights, the outcome): iv_rank = the
share of the name's previous ~60 trading days (every third day sampled, 15+ needed) with a lower IV at 15:57. His pick's percentile of iv_rank
among the list names that night (low = his options cheaper for that stock than usual), all and calm; his picks' own
iv_rank; every list name by iv_rank fifth: 2%+ his way / against; tune / check."""
import json, sys, collections, statistics as st
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from split import half
H = json.load(open(sys.argv[1])); X = [r for r in json.load(open(sys.argv[2])) if r["on"] is not None]
H.pop("_done")
import datetime as dt
def rank(s, d, iv):
    """Tonight's IV (from iv.json) vs the name's samples in the previous ~60 trading days (87 calendar days), 15+ needed."""
    lo = (dt.date.fromisoformat(d) - dt.timedelta(days=87)).isoformat()
    past = [v for x, v in H.get(s, {}).items() if lo <= x < d]
    if len(past) < 15: return None
    return 100 * sum(p < iv for p in past) / len(past)
for r in X: r["iv_rank"] = rank(r["sym"], r["date"], r["iv"])
X = [r for r in X if r["iv_rank"] is not None]
calm = lambda r: r["atr_pct"] and r["atr_pct"] < 3.6
night = collections.defaultdict(list)
for r in X: night[r["date"]].append(r)
print(len(X), "name-nights with an IV rank,", len(night), "nights,", sum(r["his"] for r in X), "his picks")
for label, ok in (("all list names", lambda r: True), ("calm (ATR < 3.6%)", calm)):
    P = collections.defaultdict(list)
    for d, rs in night.items():
        rs = [r for r in rs if ok(r)]; me = [r for r in rs if r["his"]]; v = [r["iv_rank"] for r in rs if not r["his"]]
        if me and len(v) >= 4:
            P[half(d)].append(100 * (sum(a < me[0]["iv_rank"] for a in v) + .5 * sum(a == me[0]["iv_rank"] for a in v)) / len(v))
    his = {h: [r["iv_rank"] for r in X if r["his"] and ok(r) and half(r["date"]) == h] for h in ("tune", "check")}
    oth = {h: [r["iv_rank"] for r in X if not r["his"] and ok(r) and half(r["date"]) == h] for h in ("tune", "check")}
    print(f"\n{label}: his pick's percentile of iv_rank vs the others that night (low = cheaper for its stock)")
    for h in ("tune", "check"):
        print(f"  {h:5} percentile {st.mean(P[h]):4.0f} (n{len(P[h])})   median iv_rank his {st.median(his[h]):4.0f} vs others {st.median(oth[h]):4.0f}"
              f"   his in the cheapest third (rank < 33): {100*sum(x < 33 for x in his[h])/len(his[h]):3.0f}% vs others {100*sum(x < 33 for x in oth[h])/len(oth[h]):3.0f}%")
print("\nEvery list name (his picks out), by iv_rank fifth (q1 = cheapest for its stock): 2%+ his way / 2%+ against, %")
for label, ok in (("all", lambda r: True), ("calm", calm)):
    for h in ("tune", "check"):
        P = sorted([r for r in X if half(r["date"]) == h and ok(r) and not r["his"]], key=lambda r: r["iv_rank"]); q = len(P) // 5
        G = [P[j * q:(j + 1) * q if j < 4 else len(P)] for j in range(5)]
        print(f"  {label:4} {h:5} " + " | ".join(f"q{j+1} {100*sum(r['on']>=.02 for r in g)/len(g):4.1f}/{100*sum(r['on']<=-.02 for r in g)/len(g):4.1f}" for j, g in enumerate(G)) + f"  n{len(P)}")
print("\nHis picks by their own iv_rank: 2%+ his way / against")
for h in ("tune", "check"):
    for lo, hi in ((0, 33), (33, 67), (67, 101)):
        g = [r for r in X if r["his"] and half(r["date"]) == h and lo <= r["iv_rank"] < hi]
        if g: print(f"  {h:5} rank {lo:3}-{hi:3}: n{len(g):3}  {100*sum(r['on']>=.02 for r in g)/len(g):4.1f}/{100*sum(r['on']<=-.02 for r in g)/len(g):4.1f}")
