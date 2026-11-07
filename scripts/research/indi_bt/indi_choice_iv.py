"""His 'the volatility is very low' in a measure (the user 2026-11-07: "You do not need qll the names. Go with our 50
list and add some of his trade ... We won't go overnight for weird names like hims"). On each of his overnight nights
(recs.json, Feb 2024+, Alpaca option bars), every name of strangle_rank.json's top 50 (HIMS out) + GLD + APP, at
15:57: the at-the-money call and put of the bot's expiry (1-7 days), IV from each last print (15 min max), averaged.
  ivrv  = that IV / the stock's 20-day realized volatility (close to close, to yesterday). Low = options cheap.
  iv    = the IV itself.   his_iv = IV of the 0.15-delta option on his side (the bot's own pick).
Output: <out>/iv.json (one row per night x name)."""
import json, math, os, sys, sqlite3, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import store, sim
from store import day, iv_delta, years_to_expiry
S = "/private/tmp/claude-501/-Users-alonmo-Desktop-Personal-stock-market-assistant/6fb99457-9696-4e71-87a7-c3ad635440fb/scratchpad"
A = "data/local/x/bt/"
LIST = [s for s in json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "strangle_rank.json")))[:50] if s != "HIMS"] + ["GLD", "APP"]
R = [x for x in json.load(open(S + "/choice/recs.json")) if x[0]["date"] >= "2024-02-01"]
ddb = sqlite3.connect(A + "daily_all.sqlite"); dc = {}
def closes(s):
    if s not in dc: dc[s] = dict(ddb.execute("select date,c from day where symbol=?", (s,)).fetchall())
    return dc[s]
CAL = sorted(closes("SPY"))
M = 387
out = []; out_f = sys.argv[1]
done = {(r["date"], r["sym"]) for r in json.load(open(out_f))} if os.path.exists(out_f) else set()
if done: out = json.load(open(out_f))
for j, (n, cand) in enumerate(R):
    date, side = n["date"], n["right"]
    by = {c["sym"]: c for c in cand}
    i = CAL.index(date)
    todo = []
    for s in LIST:
        if (date, s) in done or s not in by: continue
        b = [x for x in day(s, date) if x[0] <= M]
        if not b or b[-1][0] < M - 5: continue
        spot = b[-1][4]
        try:
            exp = sim.expiry_for(s, date)
            if not exp: continue
            ks = store.chain(s, exp, "C")
        except Exception as e:
            print("chain", s, date, e, flush=True); continue
        if not ks: continue
        k = min(ks, key=lambda k: abs(k - spot))
        side_ks = sorted([x for x in ks if (x > spot if side == "C" else x < spot)], key=lambda x: abs(x - spot))[:12]
        todo.append((s, spot, exp, k, side_ks))
    syms = [store.occ(s, exp, k, r) for s, _, exp, k, _ in todo for r in "CP"]
    syms += [store.occ(s, exp, x, side) for s, _, exp, _, sk in todo for x in sk]
    for q in range(0, len(syms), 100):
        try: store.fetch_bars("options", syms[q:q + 100], date, date)
        except Exception as e: print("bars", date, e, flush=True)
    for s, spot, exp, k, sk in todo:
        T = years_to_expiry(date, M, exp); ivs = []
        for r in "CP":
            bb = sim.last_bar(day(store.occ(s, exp, k, r), date), M, 15)
            x = iv_delta(bb[4], spot, k, T, 0.045, r == "C") if bb else None
            if x: ivs.append(x[0])
        if not ivs: continue
        best = None
        for x in sk:
            bb = sim.last_bar(day(store.occ(s, exp, x, side), date), M, 15)
            y = iv_delta(bb[4], spot, x, T, 0.045, side == "C") if bb else None
            if y and (best is None or abs(abs(y[1]) - 0.15) < abs(abs(best[1]) - 0.15)): best = (y[0], y[1], bb[4])
        C = closes(s); ds = CAL[i - 21:i]
        if any(d not in C for d in ds): continue
        rr = [math.log(C[ds[t]] / C[ds[t - 1]]) for t in range(1, len(ds))]
        rv = st.pstdev(rr) * math.sqrt(252)
        c = by[s]
        out.append(dict(date=date, sym=s, side=side, his=s == n["sym"], iv=sum(ivs) / len(ivs), rv=rv,
                        ivrv=sum(ivs) / len(ivs) / rv if rv else None, dte=(sim.dt.date.fromisoformat(exp) - sim.dt.date.fromisoformat(date)).days,
                        his_iv=best[0] if best else None, his_delta=best[1] if best else None, his_px=best[2] if best else None,
                        on=c.get("on"), atr_pct=c.get("atr_pct"), rs_day=c.get("rs_day")))
    if j % 10 == 0:
        json.dump(out, open(out_f, "w")); print(j, len(R), date, len(out), flush=True)
json.dump(out, open(out_f, "w")); print("done", len(out), flush=True)
