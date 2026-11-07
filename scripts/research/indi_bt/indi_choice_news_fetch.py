"""Fetches the day's own headlines (Alpaca / Benzinga, 04:00-15:57, tagged with at most 3 symbols, as news_burst_calm.py)
into data/local/x/bt/news_day/<sym>_<date>.json for every calm name-day of indi_choice_combo.py's output (argv[1])."""
import datetime as dt, json, os, sys
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import store
NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
NEWS = "data/local/x/bt/news_day"
def news_day(sym, d):
    p = f"{NEWS}/{sym}_{d}.json"
    if os.path.exists(p): return
    s = dt.datetime.fromisoformat(f"{d}T04:00").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = dt.datetime.fromisoformat(f"{d}T15:57").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"https://data.alpaca.markets/v1beta1/news?symbols={sym}&start={s}&end={e}&limit=50&sort=asc&include_content=false"
    out, tok = [], None
    while True:
        r = store._get(url + (f"&page_token={tok}" if tok else ""))
        for n in r.get("news") or []:
            if len(n.get("symbols") or []) > 3: continue
            t = dt.datetime.fromisoformat(n["created_at"].replace("Z", "+00:00")).astimezone(NY)
            out.append([t.hour * 60 + t.minute - 570, n.get("headline", "")[:160]])
        tok = r.get("next_page_token")
        if not tok: break
    json.dump(out, open(p, "w"))
K = sorted({(r["sym"], r["date"]) for r in json.load(open(sys.argv[1])) if r["atr"] < 3.6})
todo = [k for k in K if not os.path.exists(f"{NEWS}/{k[0]}_{k[1]}.json")]
print(len(K), "calm name-days,", len(todo), "to fetch", flush=True)
for j, (s, d) in enumerate(todo):
    try: news_day(s, d)
    except Exception as e: print("err", s, d, e, flush=True)
    if j % 500 == 0: print(j, flush=True)
print("done", flush=True)
