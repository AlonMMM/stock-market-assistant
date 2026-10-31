"""1-minute SIP stock bars, Dec 2021 - Dec 2023, for the champion's lists (his 40 + the 60 Favorites) and SPY, into the
shared market.sqlite (store.fetch_bars keeps whichever copy of a day has more bars). Month by month, resumable."""
import os, sys, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BT_VARIANT", "v2")
import store, fav_real as FR
U = ["SPY"] + sorted((set(store.P["universe"]) | set(FR.FAV)) - {"SPY"})
months = [(dt.date(2021, 12, 1) + dt.timedelta(days=31 * i)).replace(day=1) for i in range(26)]
months = sorted({m for m in months if m <= dt.date(2023, 12, 1)})
W, K = int(os.environ.get("FW", 1)), int(os.environ.get("FK", 0))
for k, m in enumerate(months):
    if k % W != K: continue
    nxt = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    a, b = m.isoformat(), (nxt - dt.timedelta(days=1)).isoformat()
    for i in range(0, len(U), 8):
        store.fetch_bars("stocks", U[i:i + 8], a, b)
    print(f"month {a} done ({k + 1}/{len(months)})", flush=True)
print("FETCH DONE", flush=True)
