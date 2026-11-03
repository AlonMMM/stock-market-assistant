# The user, 2026-11-03: "if the volume is go to double, 2x is scoring the same as zero for the other side ... We need to
# think about calculation equation." The volume score on a log scale and two other equations (look 4 of the score):
#   A  log2(stock ratio) - log2(SPY ratio)            (the stock vs SPY, one for one)
#   B  log2(volume score)                              (look 3's score, read on a log scale: distribution only)
#   C  (ln stock ratio - a - b ln SPY ratio) / sd      (the score in the stock's own noise; sd = its fit's residual spread)
#   D  stock ratio x SPY ratio, a 2-D table            (analysis)
# Bands set before the run: A, B 1/2/3/4; C 2/3/4/5; D stock 8x/16x, SPY 1x/2x/4x. Rules: skip each A and C band.
# Live-code year (taken trades, distribution) and the 3-year twin (top50, live; scaled walk at 2%, 3% beside it), tune
# (even ISO weeks) and check (odd) in the same run; the pick per measure = the best tune without 10-10.
# Usage: volume_score_log.py <scratchpad> <volume_trades.csv>   (volume_score.py live / twin first)
import csv, json, math, os, statistics as st, sys
from datetime import date as D
S = sys.argv[1]
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
def measures(v):
    if not v or not v.get('score') or not v.get('sd'): return None
    return {'A': math.log2(v['rs']) - math.log2(v['rspy']), 'B': math.log2(v['score']),
            'C': (math.log(v['rs']) - v['a'] - v['b'] * math.log(v['rspy'])) / v['sd'],
            'stock': math.log2(v['rs']), 'spy': math.log2(v['rspy'])}
CUTS = {'A': [1, 2, 3, 4], 'B': [1, 2, 3, 4], 'C': [2, 3, 4, 5]}
def bands(m):
    c = CUTS[m]; lo = [-1e9] + c; hi = c + [1e9]
    out = []
    for i in range(len(lo)):
        if i == 0: lab = f'< {c[0]}'
        elif i == len(c): lab = f'>= {c[-1]}'
        else: lab = f'{lo[i]}-{hi[i]}'
        out.append((lo[i], hi[i], lab))
    return out
N = json.load(open(f'{S}/volyear/volscore_live.json')); taken = set(json.load(open(f'{S}/volyear/taken_ids.json')))
live = []
for f in sorted(os.listdir(f'{S}/volyear/parts')):
    if not f.startswith('pr_'): continue
    for s in json.load(open(f'{S}/volyear/parts/' + f))['signals']:
        t = s.get('trade'); m = measures(N.get(s['id']))
        if t and s['id'] in taken and m:
            live.append((m, (t['sell'] * 100 - 0.62) / (t['buy'] * 100 + 0.62) - 1, s['date']))
R = json.load(open(f'{S}/volyear/volscore_twin.json'))
key = lambda r: '|'.join((r['date'], r['sym'], r['minute'], r['side']))
rows = [r for r in csv.DictReader(open(sys.argv[2])) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] in ('2', '3')]
tw = [(measures(R.get(key(r))), float(r['ret']), r['date']) for r in rows if r['size'] == '2' and r['view'] == 'all']
tw = [x for x in tw if x[0]]
def line(g):
    r = sorted((x[1] for x in g), reverse=True)
    return f"{len(g)} | {sum(v > 0 for v in r)/len(r):.0%} | {st.median(r):+.0%} | {sum(v >= 3 for v in r)}"
def table(name, data, m):
    print(f'\n{m} {name}: {len(data)} trades\n| {m} | Tune: n | won | median | +300% | Check: n | won | median | +300% |\n|---|---|---|---|---|---|---|---|---|')
    for lo, hi, lab in bands(m):
        cells = []
        for h in ('tune', 'check'):
            g = [x for x in data if lo <= x[0][m] < hi and half(x[2]) == h]
            cells.append(line(g) if g else '0 | | |')
        print(f'| {lab} | {cells[0]} | {cells[1]} |')
SETS = (('live year', live), ('3 years', tw), ('3 years w/o 10-10', [x for x in tw if x[2] != '2025-10-10']))
print('== Distribution: median trade by band (tune | check) ==')
for m in ('A', 'B', 'C'):
    for name, data in SETS: table(name, data, m)
print('\n== D: stock ratio x SPY ratio (median trade, won %, +300% count; n) ==')
SB = [(-1e9, 3, 'stock < 8x'), (3, 4, 'stock 8-16x'), (4, 1e9, 'stock >= 16x')]
PB = [(-1e9, 0, 'SPY < 1x'), (0, 1, 'SPY 1-2x'), (1, 2, 'SPY 2-4x'), (2, 1e9, 'SPY >= 4x')]
for name, data in SETS:
    print(f'\n{name}\n| | ' + ' | '.join(p[2] for p in PB) + ' |\n|---' * (len(PB) + 1) + '|')
    for slo, shi, slab in SB:
        cells = []
        for plo, phi, _ in PB:
            g = sorted((x[1] for x in data if slo <= x[0]['stock'] < shi and plo <= x[0]['spy'] < phi), reverse=True)
            cells.append(f'{st.median(g):+.0%} ({sum(v > 0 for v in g)/len(g):.0%}, {sum(v >= 3 for v in g)}; n {len(g)})' if g else '-')
        print(f'| {slab} | ' + ' | '.join(cells) + ' |')
# The skip rules on the 3-year twin (scaled walk, as volume_score_3y.py).
M = {key(r): measures(R.get(key(r))) for r in rows}
def walk(view, size, skip):
    tr = sorted([t for t in rows if t['view'] == view and t['size'] == size], key=lambda t: (t['date'], int(t['minute'])))
    eq0 = eq1 = 1e5; peak, dd, cur = 1e5, 0.0, None; out = {'tune': 0.0, 'check': 0.0}; qa = {'tune': [], 'check': []}; n = 0
    for t in tr:
        if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
        p = float(t['pnl']); eq0 += p
        m = M[key(t)]
        if m and skip(m): continue
        n += 1
        q = p * new_day / base_day; eq1 += q; out[half(t['date'])] += q; qa[half(t['date'])].append(q)
        peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
    wo5 = {h: sum(sorted(v, reverse=True)[5:]) for h, v in qa.items()}
    return eq1, dd, out, wo5, n
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.0f}K"
V = [('1.1.0 twin', None, lambda m: False)]
for meas in ('A', 'C'):
    V += [(f'skip {meas} {lab}', meas, (lambda lo, hi, meas: lambda m: lo <= m[meas] < hi)(lo, hi, meas)) for lo, hi, lab in bands(meas)]
print('\n== Skip rules, 3-year twin ==')
res = {}
for view in ('all', 'wo'):
    print('\n' + ('all days' if view == 'all' else 'without 10 Oct 2025'))
    for name, meas, f in V:
        e, d, h, w, n = walk(view, '2', f); e3, d3, *_ = walk(view, '3', f)
        res[(view, name)] = (e, d, h, w, n)
        print(f"  {name:20s} {n:3d}t 2%: ${e/1e3:5.0f}K dd {100*d:4.1f}% | tune {k(h['tune']):>6} w/o5 {k(w['tune']):>6} | check {k(h['check']):>6} w/o5 {k(w['check']):>6} | 3%: ${e3/1e3:5.0f}K dd {100*d3:4.1f}%")
for meas in ('A', 'C'):
    pick = max((v for v in V if v[1] == meas), key=lambda v: res[('wo', v[0])][2]['tune'])
    print(f'🎯 {meas} pick on tune (without 10-10): {pick[0]}')
