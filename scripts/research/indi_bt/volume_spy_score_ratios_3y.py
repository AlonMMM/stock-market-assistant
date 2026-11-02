# The 3-year twin (top50, live): for plan trades, the stock's and SPY's 3-minute volume vs the median of the same window
# over the prior 20 sessions, at the alert (the window ending the minute before the buy minute); then the account
# (scaled walk) with plan trades dropped when stock/SPY < 4 (3 / 5) or SPY >= 2x (1.5 / 3), as on the live year.
import csv, sys, json, statistics as st
from datetime import date as D, timedelta
from store import day
rows = [r for r in csv.DictReader(open(sys.argv[1])) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] in ('2', '3')]
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
C = {}
def bars(sym, d):
    if (sym, d) not in C:
        C[(sym, d)] = {x[0]: x[5] for x in day(sym, d)}
    return C[(sym, d)]
def win(v, m): return sum(v[k] for k in (m - 2, m - 1, m)) if all(k in v for k in (m - 2, m - 1, m)) else None
def ratio(sym, d, m):
    cur = win(bars(sym, d), m)
    hist, x = [], D.fromisoformat(d)
    for i in range(1, 40):
        if len(hist) >= 20: break
        p = (x - timedelta(days=i)).isoformat()
        b = bars(sym, p)
        if len(b) > 300:
            w = win(b, m)
            if w: hist.append(w)
    return cur / st.median(hist) if cur and len(hist) >= 10 else None
R = {}
for r in rows:
    k = (r['date'], r['sym'], r['minute'], r['side'])
    if k in R: continue
    m = int(r['minute']) - 1
    R[k] = (ratio(r['sym'], r['date'], m), ratio('SPY', r['date'], m))
    if len(C) > 4000: C.clear()
json.dump({'|'.join(k): v for k, v in R.items()}, open(sys.argv[2], 'w'))
print(len(R), 'trades')
