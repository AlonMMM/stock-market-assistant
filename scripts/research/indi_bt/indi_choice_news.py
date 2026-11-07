"""News in his choice (the user 2026-11-07: "Yes", to counting each name's headlines). Calm name-nights of
indi_choice_combo.py's output (argv[1]; the list, Mon-Thu, no earnings, ATR < 3.6%) with the day's own headlines
04:00-15:57 (news_day/, at most 3 symbols a headline). news = any headline; news3 = 3+; late = a headline after 13:30.
1) his calm picks vs the calm names on the same nights (same side): share with news, median count; tune / check.
2) every calm name-night: 2%+ his way / against with and without news, alone and with the combination
   (rs_day >= 1 and the 15:57 price past the previous 10 days' extreme)."""
import json, os, sys, statistics as st, collections
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from split import half
NEWS = "data/local/x/bt/news_day"
X = [r for r in json.load(open(sys.argv[1])) if r["atr"] < 3.6]
miss = 0
for r in X:
    p = f"{NEWS}/{r['sym']}_{r['date']}.json"
    if not os.path.exists(p): r["n"] = None; miss += 1; continue
    N = [m for m, _ in json.load(open(p)) if m <= 387]
    r["n"] = len(N); r["late"] = any(m >= 240 for m in N)
X = [r for r in X if r["n"] is not None]
print(len(X), "calm name-night-sides with news data,", miss, "missing")
nights = {(r["date"], r["side"]) for r in X if r["his"]}
print("\n1) His calm picks vs the other calm names, same nights and side")
for h in ("tune", "check"):
    me = [r for r in X if r["his"] and half(r["date"]) == h]
    ot = [r for r in X if not r["his"] and (r["date"], r["side"]) in nights and half(r["date"]) == h]
    f = lambda g, k: 100 * sum(1 for r in g if k(r)) / len(g)
    print(f"  {h:5} his n{len(me):3}: news {f(me, lambda r: r['n'] > 0):3.0f}%  3+ {f(me, lambda r: r['n'] >= 3):3.0f}%  late {f(me, lambda r: r['late']):3.0f}%  median {st.median(r['n'] for r in me):.0f}"
          f"   | others n{len(ot):4}: news {f(ot, lambda r: r['n'] > 0):3.0f}%  3+ {f(ot, lambda r: r['n'] >= 3):3.0f}%  late {f(ot, lambda r: r['late']):3.0f}%  median {st.median(r['n'] for r in ot):.0f}")
print("\n2) Every calm name-night (his picks out): 2%+ his way / against")
combo = lambda r: r["rs"] >= 1 and r["b10"]
G = [("no news", lambda r: r["n"] == 0), ("news", lambda r: r["n"] > 0), ("news 3+", lambda r: r["n"] >= 3), ("late news", lambda r: r["late"]),
     ("combo", combo), ("combo + no news", lambda r: combo(r) and r["n"] == 0), ("combo + news", lambda r: combo(r) and r["n"] > 0),
     ("combo + news 3+", lambda r: combo(r) and r["n"] >= 3), ("rs>=1 + news", lambda r: r["rs"] >= 1 and r["n"] > 0)]
for name, g in G:
    cells = []
    for h in ("tune", "check"):
        x = [r for r in X if not r["his"] and half(r["date"]) == h and g(r)]
        cells.append(f"n{len(x):5}  {100*sum(r['on']>=.02 for r in x)/len(x):5.1f} / {100*sum(r['on']<=-.02 for r in x)/len(x):4.1f}" if x else "-")
    print(f"  {name:16} tune {cells[0]}   check {cells[1]}")
print("\nHis calm picks with and without news: 2%+ his way / against")
for h in ("tune", "check"):
    for name, g in (("news", lambda r: r["n"] > 0), ("no news", lambda r: r["n"] == 0)):
        x = [r for r in X if r["his"] and half(r["date"]) == h and g(r)]
        if x: print(f"  {h:5} {name:8} n{len(x):3}  {100*sum(r['on']>=.02 for r in x)/len(x):5.1f} / {100*sum(r['on']<=-.02 for r in x)/len(x):4.1f}")
