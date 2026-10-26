"""Downloads regular-session 1-min bars one symbol at a time, a month at a time, skipping symbols the data API refuses
(a bad or delisted ticker answers 400 for the whole batch). Prints the refused ones.
  node --env-file=.env scripts/research/indi_bt/run.mjs fetch_each.py <start> <end> SYM [SYM...]"""
import sys, datetime as dt, urllib.error
from store import fetch_bars

start, end, syms = sys.argv[1], sys.argv[2], sys.argv[3:]
bad = []
for s in syms:
    d = dt.date.fromisoformat(start)
    try:
        while d.isoformat() <= end:
            e = min((d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1), dt.date.fromisoformat(end))
            fetch_bars("stocks", [s], d.isoformat(), e.isoformat())
            d = e + dt.timedelta(days=1)
        print(s, "done", flush=True)
    except urllib.error.HTTPError as x:
        bad.append(s); print(s, "refused", x.code, d.isoformat(), x.read().decode()[:200], flush=True)
print("refused:", " ".join(bad))
