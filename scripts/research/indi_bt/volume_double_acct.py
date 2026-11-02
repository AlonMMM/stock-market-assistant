# The user, 2026-11-02: "I would like to find trade to double up the bet." Account test of the scan's groups (cuts from
# the tune tertiles, set before this run): x2 size on the group (3%: capped at the service's 5% a position = x1.67).
# 3-year twin, top50, live; with and without 10 Oct 2025; tune = even ISO weeks, check = odd.
import csv, sys, statistics as st
from datetime import date as D
from store import day
CSV = sys.argv[1]
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
allr = [r for r in csv.DictReader(open(CSV)) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] in ('2', '3')]
feat = {}
for r in allr:
    key = (r['date'], r['sym'], r['minute'], r['side'])
    if key in feat: continue
    m = int(r['minute']); sg = 1 if r['side'] == 'C' else -1
    b = {x[0]: x for x in day(r['sym'], r['date'])}
    f = {'call': r['side'] == 'C', 'price': float(r['buy'])}
    if 0 in b and m - 1 in b:
        c = b[m - 1][4]
        vols = [b[i][5] for i in range(m) if i in b]
        f['vol10'] = (sum(vols[-10:]) / 10) / (sum(vols) / len(vols))
        f['move_30'] = sg * (c / b[m - 31][4] - 1) if m - 31 in b else sg * (c / b[0][1] - 1)
        hi = max(b[i][2] for i in range(m) if i in b); lo = min(b[i][3] for i in range(m) if i in b)
        pos = (c - lo) / (hi - lo) if hi > lo else .5
        f['range_pos'] = pos if sg > 0 else 1 - pos
    feat[key] = f
V = {
    'x2 volume burst (last 10 min >= 1.2x the day avg)': lambda f: f.get('vol10', 0) >= 1.199,
    '  neighbour: >= 1.0x': lambda f: f.get('vol10', 0) >= 1.0,
    '  neighbour: >= 1.5x': lambda f: f.get('vol10', 0) >= 1.5,
    'x2 calls': lambda f: f['call'],
    'x2 at the day high (range pos >= 0.955)': lambda f: f.get('range_pos', 0) >= 0.9552,
    'x2 strong last 30 min (>= +1.34% our way)': lambda f: f.get('move_30', 0) >= 0.01335,
    'x2 option >= $0.92': lambda f: f['price'] >= 0.92,
    'x2 calls with volume burst': lambda f: f['call'] and f.get('vol10', 0) >= 1.199,
}
def walk(view, size, pick):
    tr = sorted([t for t in allr if t['view'] == view and t['size'] == size], key=lambda t: (t['date'], int(t['minute'])))
    big = 2 if size == '2' else 5 / 3
    eq0 = eq1 = 1e5; peak, dd, cur = 1e5, 0.0, None; out = {'tune': 0.0, 'check': 0.0}; q_all = []
    for t in tr:
        if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
        p = float(t['pnl']); eq0 += p
        mult = big if pick and pick(feat[(t['date'], t['sym'], t['minute'], t['side'])]) else 1
        q = p * mult * new_day / base_day
        eq1 += q; out[half(t['date'])] += q; q_all.append(q)
        peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
    q_all.sort(reverse=True)
    return eq1, dd, out, sum(q_all[5:])
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1000:.0f}K"
for view in ('all', 'wo'):
    print(f"\n{'all days' if view == 'all' else 'without 10 Oct 2025'}")
    for name, pick in [('1.1.0 twin', None)] + list(V.items()):
        n = sum(1 for t in allr if t['view'] == view and t['size'] == '2' and pick and pick(feat[(t['date'], t['sym'], t['minute'], t['side'])]))
        e2, d2, h2, w2 = walk(view, '2', pick); e3, d3, h3, w3 = walk(view, '3', pick)
        print(f"  {name:50s} {n:3d}x2  2%: ${e2/1e3:6.0f}K dd {100*d2:4.1f}% tune {k(h2['tune']):>6} check {k(h2['check']):>6} w/o5 {k(w2):>6} | 3%: ${e3/1e3:6.0f}K dd {100*d3:4.1f}% tune {k(h3['tune'])} check {k(h3['check'])}")

# Fair line: the flat size (every trade x m at 2%) with the same worst drop as the x2 version.
print('\nvs the flat line at the same worst drop (2% base)')
for view in ('all', 'wo'):
    for name in ['x2 volume burst (last 10 min >= 1.2x the day avg)', 'x2 at the day high (range pos >= 0.955)', 'x2 strong last 30 min (>= +1.34% our way)', 'x2 calls with volume burst']:
        e, d, h, w = walk(view, '2', V[name])
        lo, hi = 1.0, 2.0
        for _ in range(30):
            m = (lo + hi) / 2
            fe, fd, fh, fw = walk(view, '2', lambda f, m=m: True) if False else (None,) * 4
            # flat x m: reuse walk with a constant multiplier
            tr = sorted([t for t in allr if t['view'] == view and t['size'] == '2'], key=lambda t: (t['date'], int(t['minute'])))
            eq0 = eq1 = 1e5; peak, dd, cur = 1e5, 0.0, None; out = {'tune': 0.0, 'check': 0.0}; qa = []
            for t in tr:
                if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
                p = float(t['pnl']); eq0 += p; q = p * m * new_day / base_day
                eq1 += q; out[half(t['date'])] += q; qa.append(q); peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
            if dd < d: lo = m
            else: hi = m
        qa.sort(reverse=True)
        print(f"  {view:3} {name[:40]:40s} x2: ${e/1e3:5.0f}K dd {100*d:.1f}% tune {k(h['tune'])} check {k(h['check'])} w/o5 {k(w)} | flat {2*m:.2f}%: ${eq1/1e3:5.0f}K tune {k(out['tune'])} check {k(out['check'])} w/o5 {k(sum(qa[5:]))}")
