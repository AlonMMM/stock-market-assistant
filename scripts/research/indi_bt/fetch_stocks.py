"""Downloads regular-session 1-min bars for the universe and SPY, a month at a time.
  node --env-file=.env scripts/research/indi_bt/run.mjs fetch_stocks.py [start] [end]"""
import sys, datetime as dt
from store import P, fetch_bars

start = sys.argv[1] if len(sys.argv) > 1 else "2024-01-02"
end = sys.argv[2] if len(sys.argv) > 2 else P["test"][1]
syms = ["SPY"] + P["universe"]
d = dt.date.fromisoformat(start)
while d.isoformat() <= end:
    e = min((d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1), dt.date.fromisoformat(end))
    for i in range(0, len(syms), 10):
        fetch_bars("stocks", syms[i:i + 10], d.isoformat(), e.isoformat())
    print(d.isoformat()[:7], "done", flush=True)
    d = e + dt.timedelta(days=1)
