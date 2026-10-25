"""Can the bot trade a stock's options? From Alpaca's chain snapshots on the last session (greeks, quotes, daily bars):
the nearest expiry 1-7 days out; on each side, the contract with delta closest to 0.15 and, failing it, the fallback
up to 0.30 delta (the rule to be tested). A contract is usable when its price (mid of the quote, else the last trade)
is >= $0.20 and it traded >= 200 contracts that day (the bot asks 200 in 30 minutes: a day's 200 is a loose screen).
  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs opt_fit.py SYM,SYM,...  -> data/local/x/bt/opt_fit.json"""
import datetime as dt, json, sys, urllib.parse
from store import _get

DAY = dt.date(2026, 10, 23)
out = {}
for sym in sys.argv[1].split(","):
    snaps, token = {}, None
    while True:
        q = dict(feed="opra", limit=1000, expiration_date_gte=(DAY + dt.timedelta(days=1)).isoformat(),
                 expiration_date_lte=(DAY + dt.timedelta(days=7)).isoformat())
        if token: q["page_token"] = token
        r = _get(f"https://data.alpaca.markets/v1beta1/options/snapshots/{sym}?" + urllib.parse.urlencode(q))
        snaps.update(r.get("snapshots") or {})
        token = r.get("next_page_token")
        if not token: break
    rows = []
    for occ, s in snaps.items():
        d = (s.get("greeks") or {}).get("delta")
        if d is None: continue
        qt = s.get("latestQuote") or {}; tr = s.get("latestTrade") or {}; b = s.get("dailyBar") or {}
        px = (qt["bp"] + qt["ap"]) / 2 if qt.get("bp") and qt.get("ap") else tr.get("p")
        exp = dt.date(2000 + int(occ[-15:-13]), int(occ[-13:-11]), int(occ[-11:-9]))
        rows.append(dict(occ=occ, exp=exp.isoformat(), right=occ[-9], delta=abs(d), px=px or 0,
                         vol=b.get("v", 0) if b.get("t", "")[:10] == DAY.isoformat() else 0))
    res = {"expiry": None}
    if rows:
        first = min(r["exp"] for r in rows); res["expiry"] = first
        for side in "CP":
            S = [r for r in rows if r["exp"] == first and r["right"] == side and 0.03 <= r["delta"] <= 0.5]
            if not S: res[side] = None; continue
            base = min(S, key=lambda r: abs(r["delta"] - 0.15))
            ok = lambda r: r["px"] >= 0.2 and r["vol"] >= 200
            fb = sorted((r for r in S if base["delta"] <= r["delta"] <= 0.30 and ok(r)), key=lambda r: r["delta"])
            res[side] = dict(d15=round(base["delta"], 2), px15=round(base["px"], 2), vol15=base["vol"], ok15=ok(base),
                             fb=dict(delta=round(fb[0]["delta"], 2), px=round(fb[0]["px"], 2), vol=fb[0]["vol"]) if fb else None)
    out[sym] = res
    print(sym, res, flush=True)
json.dump(out, open("data/local/x/bt/opt_fit.json", "w"), indent=1)
