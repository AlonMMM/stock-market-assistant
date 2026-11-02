# The user, 2026-11-03: "call it volume score. and go". Distribution of the trades by the volume score
# (stock window ratio / (e^a * SPY ratio^b), a, b = the stock's SPY volume beta over its prior 60 sessions), live-code
# year (taken trades) and the 3-year twin, tune (even ISO weeks) and check (odd) apart. Bands fixed before the run.
import csv, json, os, statistics as st, sys
from datetime import date as D
S = sys.argv[1]
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
N = json.load(open(f'{S}/volyear/volscore_live.json')); taken = set(json.load(open(f'{S}/volyear/taken_ids.json')))
live = []
for f in sorted(os.listdir(f'{S}/volyear/parts')):
    if not f.startswith('pr_'): continue
    for s in json.load(open(f'{S}/volyear/parts/' + f))['signals']:
        t = s.get('trade'); v = N.get(s['id'])
        if t and s['id'] in taken and v and v['score']:
            live.append((v['score'], (t['sell'] * 100 - 0.62) / (t['buy'] * 100 + 0.62) - 1, s['kind'], s['date'], v['b']))
R = json.load(open(f'{S}/volyear/volscore_twin.json'))
tw = []
for r in csv.DictReader(open(sys.argv[2])):
    if r['list'] == 'top50' and r['version'] == 'live' and r['size'] == '2' and r['view'] == 'all':
        v = R.get('|'.join((r['date'], r['sym'], r['minute'], r['side'])))
        if v and v['score']: tw.append((v['score'], float(r['ret']), r['alert'], r['date'], v['b']))
B = [(0, 2, '< 2'), (2, 4, '2-4'), (4, 6, '4-6'), (6, 10, '6-10'), (10, 20, '10-20'), (20, 40, '20-40'), (40, 1e9, '>= 40')]
def q(v, p): v = sorted(v); return v[min(len(v) - 1, int(p * len(v)))]
def table(name, rows):
    print(f'\n{name}: {len(rows)} trades')
    print('| Score | Trades | Won | Median | Avg | Avg w/o best 2 | +300% | Plan / shock |')
    print('|---|---|---|---|---|---|---|---|')
    for lo, hi, lab in B:
        g = [x for x in rows if lo <= x[0] < hi]
        if not g: continue
        r = sorted((x[1] for x in g), reverse=True)
        print(f"| {lab} | {len(g)} | {sum(v > 0 for v in r)/len(r):.0%} | {st.median(r):+.0%} | {st.mean(r):+.0%} | {st.mean(r[2:]) if len(r) > 2 else 0:+.0%} | {sum(v >= 3 for v in r)} | {sum(x[2]=='plan' for x in g)} / {sum(x[2]=='shock' for x in g)} |")
for name, rows in (('Live code year', live), ('3 years', tw), ('3 years without 10 Oct 2025', [x for x in tw if x[3] != '2025-10-10'])):
    for h in ('tune', 'check'):
        table(f'{name}, {h}', [x for x in rows if half(x[3]) == h])
for name, rows in (('live', live), ('3y', tw)):
    print(f"{name}: score median {st.median(x[0] for x in rows):.1f}, beta median {st.median(x[4] for x in rows):.2f}, p10/p90 beta {q([x[4] for x in rows], .1):.2f}/{q([x[4] for x in rows], .9):.2f}")
tune = sorted(x[0] for x in tw if half(x[3]) == 'tune' and x[3] != '2025-10-10')
print('3y tune quintile cuts:', [round(q(tune, p), 1) for p in (.2, .4, .6, .8)], ' tertiles:', [round(q(tune, p), 1) for p in (1/3, 2/3)])
