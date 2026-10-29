"""Downloads the SPY options risk_tests.py's overnight hedge needs: for every trading day from Feb 2024, the 16 OTM
strikes nearest the money on both sides at the hedge expiry (sim.expiry_for), that day and the next session.
  node --env-file=.env <dir>/run.mjs hedge_fetch.py [start]"""
import sys, urllib.error
import sim
from store import calendar, day, fetch_bars, occ
from signals import series

CAL = calendar()
start = sys.argv[1] if len(sys.argv) > 1 else "2024-02-01"
days = [d for d in CAL[:-1] if d >= start]
for n, d in enumerate(days):
    nd = CAL[CAL.index(d) + 1]
    spot = series(day("SPY", d))[0][389]
    exp = sim.expiry_for("SPY", d)
    if not spot or not exp: continue
    syms = []
    for right in ("C", "P"):
        ks = [k for k in sim.chain("SPY", exp, right) if (spot <= k <= spot * 1.2 if right == "C" else spot * 0.8 <= k <= spot)]
        syms += [occ("SPY", exp, k, right) for k in sorted(ks, key=lambda k: abs(k - spot))[:sim.C["max_strikes"]]]
    try: fetch_bars("options", syms, d, min(nd, exp))
    except urllib.error.HTTPError as x: print(d, "refused", x.code, flush=True)
    if n % 50 == 0: print(d, n, "of", len(days), flush=True)
print("done", flush=True)
