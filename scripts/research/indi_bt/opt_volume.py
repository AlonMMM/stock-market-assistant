"""Options volume per stock on the last session, from Alpaca's option chain snapshots (every contract's daily bar).
  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs opt_volume.py SYM,SYM,...   (from the repo root)
-> data/local/x/bt/opt_volume.json {sym: {date, volume, calls, puts, near (expiring within 8 days), contracts}}"""
import collections, datetime as dt, json, sys, urllib.parse
from store import _get

out = {}
for sym in sys.argv[1].split(","):
    tot = collections.Counter(); dates = collections.Counter(); token = None; n = 0
    while True:
        q = dict(feed="opra", limit=1000)
        if token: q["page_token"] = token
        r = _get(f"https://data.alpaca.markets/v1beta1/options/snapshots/{sym}?" + urllib.parse.urlencode(q))
        for occ, s in (r.get("snapshots") or {}).items():
            b = s.get("dailyBar")
            if not b: continue
            n += 1; dates[b["t"][:10]] += 1
            tot[(b["t"][:10], occ)] = b["v"]
        token = r.get("next_page_token")
        if not token: break
    if not dates: out[sym] = None; continue
    day = max(dates)
    v = {o: x for (d, o), x in tot.items() if d == day}
    right = lambda o: o[len(o) - 9]
    exp = lambda o: dt.date(2000 + int(o[-15:-13]), int(o[-13:-11]), int(o[-11:-9]))
    near = sum(x for o, x in v.items() if (exp(o) - dt.date.fromisoformat(day)).days <= 8)
    out[sym] = dict(date=day, volume=sum(v.values()), calls=sum(x for o, x in v.items() if right(o) == "C"),
                    puts=sum(x for o, x in v.items() if right(o) == "P"), near=near, contracts=n)
    print(sym, out[sym], flush=True)
json.dump(out, open("data/local/x/bt/opt_volume.json", "w"), indent=1)
