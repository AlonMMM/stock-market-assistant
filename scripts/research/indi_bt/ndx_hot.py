"""Each month's hot Nasdaq-100 stocks in 2026, from the month before only (the user, 2026-10-29: "hot stocks, from the
nasdaq 100. Atlist for 2026"; ndx_test.py). Daily bars (Alpaca, split-adjusted) 2025-06 to 2026-10 for ndx_2026.txt
and QQQ. For each month M, on the trading days before M's first:
  momentum  the stock's return over the last 21 trading days minus QQQ's
  in play   its mean daily dollar volume over the last 21 trading days over its mean over the last 126
The top 20 of each. -> data/local/x/bt/ndx_hot.json {month: {"momentum": [...], "inplay": [...]}}

  node --env-file=.env <dir>/run.mjs ndx_hot.py      (from the app repo root)
"""
import json, os, sys, urllib.parse, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import _get

SYMS = [s for line in open(os.path.join(HERE, "ndx_2026.txt")) if not line.startswith("#") for s in line.split() if s != "GOOG"]
MONTHS = [f"2026-{m:02d}" for m in range(1, 11)]


def daily(syms):
    out, token = {}, None
    while True:
        q = dict(symbols=",".join(syms), timeframe="1Day", start="2025-06-01", end="2026-10-23", limit=10000, adjustment="split", feed="sip")
        if token: q["page_token"] = token
        j = _get("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(q))
        for s, bs in (j.get("bars") or {}).items(): out.setdefault(s, []).extend((b["t"][:10], b["c"], b["c"] * b["v"]) for b in bs)
        token = j.get("next_page_token")
        if not token: return out


def main():
    D = {}
    for i in range(0, len(SYMS) + 1, 30): D.update(daily((SYMS + ["QQQ"])[i:i + 30]))
    q = D["QQQ"]; out = {}
    for M in MONTHS:
        first = f"{M}-01"
        qb = [x for x in q if x[0] < first]
        qret = qb[-1][1] / qb[-22][1] - 1
        mom, inp = {}, {}
        for s in SYMS:
            b = [x for x in D.get(s, []) if x[0] < first]
            if len(b) < 127: continue
            mom[s] = b[-1][1] / b[-22][1] - 1 - qret
            inp[s] = st.fmean(x[2] for x in b[-21:]) / st.fmean(x[2] for x in b[-126:])
        out[M] = {"momentum": sorted(mom, key=mom.get, reverse=True)[:20], "inplay": sorted(inp, key=inp.get, reverse=True)[:20]}
        print(M, "momentum:", " ".join(out[M]["momentum"]), "| in play:", " ".join(out[M]["inplay"]), flush=True)
    json.dump(out, open("data/local/x/bt/ndx_hot.json", "w"), indent=1)


if __name__ == "__main__":
    main()
