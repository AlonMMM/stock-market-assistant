"""Cheap options the way he means it (the user 2026-11-07: "Cheap option is not calculated from the price itself. Cheap
say low iv compare to the stock relative. E.g nvda 50% iv is not cheap while in dell is very chip"). Every third trading day
Feb 2024 - Sep 2026, every name of the list (strangle_rank top 50, HIMS out, + GLD + APP): the at-the-money call and
put IV at 15:57 of the bot's expiry (1-7 days), averaged (Alpaca prints, 15 min max). Then per name and day
iv_rank = the share of the name's previous 60 trading days with a lower IV (needs 30+; no look-ahead).
Output: <out>/ivhist.json {sym: {date: iv}} (resumable)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import store, sim
from store import day, iv_delta, years_to_expiry
LIST = [s for s in json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "strangle_rank.json")))[:50] if s != "HIMS"] + ["GLD", "APP"]
M = 387
out_f = sys.argv[1]
H = json.load(open(out_f)) if os.path.exists(out_f) else {}
CAL = [d for d in store.calendar() if "2024-02-01" <= d <= "2026-09-30"][::3]   # every third day: ~20 samples in 60 (Alpaca's rate limit)
for j, date in enumerate(CAL):
    if H.get("_done", {}).get(date): continue
    todo = []
    for s in LIST:
        b = [x for x in day(s, date) if x[0] <= M]
        if not b or b[-1][0] < M - 5: continue
        spot = b[-1][4]
        try:
            exp = sim.expiry_for(s, date)
            ks = store.chain(s, exp, "C") if exp else []
        except Exception as e:
            print("chain", s, date, e, flush=True); continue
        if ks: todo.append((s, spot, exp, min(ks, key=lambda k: abs(k - spot))))
    syms = [store.occ(s, exp, k, r) for s, _, exp, k in todo for r in "CP"]
    for q in range(0, len(syms), 100):
        try: store.fetch_bars("options", syms[q:q + 100], date, date)
        except Exception as e: print("bars", date, e, flush=True)
    for s, spot, exp, k in todo:
        T = years_to_expiry(date, M, exp); ivs = []
        for r in "CP":
            bb = sim.last_bar(day(store.occ(s, exp, k, r), date), M, 15)
            x = iv_delta(bb[4], spot, k, T, 0.045, r == "C") if bb else None
            if x: ivs.append(x[0])
        if ivs: H.setdefault(s, {})[date] = round(sum(ivs) / len(ivs), 4)
    H.setdefault("_done", {})[date] = 1
    if j % 10 == 0:
        json.dump(H, open(out_f, "w")); print(j, len(CAL), date, flush=True)
json.dump(H, open(out_f, "w")); print("done", flush=True)
