# The user, 2026-11-02: "I would like to find trade to double up the bet." Volume 1.1.0 3-year twin (top50, live, 2%),
# without 10 Oct 2025. Per trade: features known at the buy minute; tertiles cut on tune, the same cuts on check.
import csv, sys, statistics as st, json
from collections import defaultdict
from datetime import date as D
from store import day
rows = [r for r in csv.DictReader(open(sys.argv[1])) if r['list'] == 'top50' and r['version'] == 'live' and r['view'] == 'wo' and r['size'] == '2']
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
spy = {}
nth = defaultdict(int); nday = defaultdict(int)
for r in sorted(rows, key=lambda r: (r['date'], int(r['minute']))):
    m = int(r['minute']); sg = 1 if r['side'] == 'C' else -1
    nth[(r['sym'], r['date'])] += 1; nday[r['date']] += 1
    f = {'kind': r['alert'], 'side': r['side'], 'minute': m, 'price': float(r['buy']), 'spread': float(r['spread']) / max(float(r['buy']), .01),
         'delta': float(r['delta']), 'weekday': D.fromisoformat(r['date']).weekday(), 'nth_stock': nth[(r['sym'], r['date'])], 'nth_day': nday[r['date']]}
    b = {x[0]: x for x in day(r['sym'], r['date'])}
    if r['date'] not in spy: spy[r['date']] = {x[0]: x for x in day('SPY', r['date'])}
    s = spy[r['date']]
    if 0 in b and m - 1 in b:
        c = b[m - 1][4]; o = b[0][1]
        f['move_open'] = sg * (c / o - 1)
        f['move_30'] = sg * (c / b[max(m - 31, 0)][4] - 1) if m - 31 in b else f['move_open']
        hi = max(b[i][2] for i in range(m) if i in b); lo = min(b[i][3] for i in range(m) if i in b)
        pos = (c - lo) / (hi - lo) if hi > lo else .5
        f['range_pos'] = pos if sg > 0 else 1 - pos
        vols = [b[i][5] for i in range(m) if i in b]
        f['vol10_vs_day'] = (sum(vols[-10:]) / 10) / (sum(vols) / len(vols)) if vols else None
        f['day_range'] = (hi - lo) / o
        if 0 in s and m - 1 in s:
            f['spy_open'] = sg * (s[m - 1][4] / s[0][1] - 1)
            f['rs_open'] = f['move_open'] - f['spy_open']
    r['f'] = f; r['ret'] = float(r['ret'])
print(len(rows), 'trades;', sum('move_open' in r['f'] for r in rows), 'with bars')
def g(t):
    ret = [r['ret'] for r in t]
    if not ret: return '-'
    small = [x for x in ret if x < 3]
    return f"n{len(t):3} avg{st.mean(ret):+5.0%} med{st.median(ret):+5.0%} big{sum(x >= 3 for x in ret):2} avg<300%{st.mean(small) if small else 0:+5.0%}"
num = ['minute', 'price', 'spread', 'delta', 'move_open', 'move_30', 'range_pos', 'vol10_vs_day', 'day_range', 'spy_open', 'rs_open']
cat = ['kind', 'side', 'weekday', 'nth_stock', 'nth_day']
for k in cat:
    print(f'\n{k}')
    for v in sorted({r['f'][k] for r in rows}, key=str):
        t = [r for r in rows if r['f'][k] == v]
        print(f'  {str(v):6} tune {g([r for r in t if half(r["date"]) == "tune"])} | check {g([r for r in t if half(r["date"]) == "check"])}')
for k in num:
    tv = sorted(r['f'][k] for r in rows if half(r['date']) == 'tune' and r['f'].get(k) is not None)
    c1, c2 = tv[len(tv) // 3], tv[2 * len(tv) // 3]
    print(f'\n{k} (cuts {c1:.4g} / {c2:.4g})')
    for name, ok in [('low', lambda x: x < c1), ('mid', lambda x: c1 <= x < c2), ('high', lambda x: x >= c2)]:
        t = [r for r in rows if r['f'].get(k) is not None and ok(r['f'][k])]
        print(f'  {name:4} tune {g([r for r in t if half(r["date"]) == "tune"])} | check {g([r for r in t if half(r["date"]) == "check"])}')
print('\nall  tune', g([r for r in rows if half(r['date']) == 'tune']), '| check', g([r for r in rows if half(r['date']) == 'check']))
