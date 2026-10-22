"""Downloads regular-session 1-min bars for the given symbols, a month at a time (for a new stock list).
  node --env-file=.env scripts/research/indi_bt/run.mjs fetch_list.py <start> <end> SYM [SYM...]"""
import sys, datetime as dt
from store import fetch_bars

start, end, syms = sys.argv[1], sys.argv[2], sys.argv[3:]
d = dt.date.fromisoformat(start)
while d.isoformat() <= end:
    e = min((d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1), dt.date.fromisoformat(end))
    for i in range(0, len(syms), 10):
        fetch_bars("stocks", syms[i:i + 10], d.isoformat(), e.isoformat())
    print(d.isoformat()[:7], "done", flush=True)
    d = e + dt.timedelta(days=1)
