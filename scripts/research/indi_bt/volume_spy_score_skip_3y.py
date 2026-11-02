# The 3-year twin (top50, live): for plan trades, the stock's and SPY's 3-minute volume vs the median of the same window
# over the prior 20 sessions, at the alert (the window ending the minute before the buy minute); then the account
# (scaled walk) with plan trades dropped when stock/SPY < 4 (3 / 5) or SPY >= 2x (1.5 / 3), as on the live year.
import csv, sys, statistics as st
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
import json
RS = json.load(open(sys.argv[2]))
R = {tuple(k.split('|')): v for k, v in RS.items()}
def walk(view, size, drop):
    tr = sorted([t for t in rows if t['view'] == view and t['size'] == size], key=lambda t: (t['date'], int(t['minute'])))
    eq0 = eq1 = 1e5; peak, dd, cur = 1e5, 0.0, None; out = {'tune': 0.0, 'check': 0.0}; qa = []; gone = []
    for t in tr:
        if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
        p = float(t['pnl']); eq0 += p
        v = R.get((t['date'], t['sym'], t['minute'], t['side']))
        if drop and v and v[0] and v[1] and drop(*v): gone.append(float(t['ret'])); continue
        q = p * new_day / base_day; eq1 += q; out[half(t['date'])] += q; qa.append(q); peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
    qa.sort(reverse=True)
    return eq1, dd, out, sum(qa[5:]), gone
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.0f}K"
sc = lambda a, b: a / b
V = [('1.1.0 twin', None), ('skip score 1-3', lambda a, b: 1 <= a / b < 3), ('  skip 1-2', lambda a, b: 1 <= a / b < 2), ('  skip 1-4', lambda a, b: 1 <= a / b < 4), ('  skip 0.8-3', lambda a, b: 0.8 <= a / b < 3)]
for view in ('all', 'wo'):
    print('\n' + ('all days' if view == 'all' else 'without 10 Oct 2025'))
    for name, f in V:
        e, d, h, w, g = walk(view, '2', f); e3, d3, _, _, _ = walk(view, '3', f)
        gs = sorted(g)
        extra = f" | gone {len(g)}: median {100*gs[len(gs)//2]:+.0f}%, won {sum(x > 0 for x in g)}, +300% {sum(x >= 3 for x in g)}" if g else ''
        print(f"  {name:26s} 2%: ${e/1e3:5.0f}K dd {100*d:4.1f}% tune {k(h['tune']):>6} check {k(h['check']):>6} w/o5 {k(w):>6} | 3%: ${e3/1e3:5.0f}K dd {100*d3:4.1f}%{extra}")
