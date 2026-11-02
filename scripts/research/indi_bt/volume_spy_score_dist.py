# Distribution of the trades by the stock/SPY volume score: live code's year (pr_ taken trades) and the 3-year twin.
import csv, json, os, statistics as st, sys
S = sys.argv[1]
N = json.load(open(f'{S}/volyear/spynorm.json')); taken = set(json.load(open(f'{S}/volyear/taken_ids.json')))
live = []
for f in sorted(os.listdir(f'{S}/volyear/parts')):
    if not f.startswith('pr_'): continue
    for s in json.load(open(f'{S}/volyear/parts/' + f))['signals']:
        t = s.get('trade')
        if t and s['id'] in taken:
            live.append((N[s['id']]['rs'] / N[s['id']]['rspy'], (t['sell'] * 100 - 0.62) / (t['buy'] * 100 + 0.62) - 1, s['kind'], s['date'], N[s['id']]['rs'], N[s['id']]['rspy']))
R = json.load(open(f'{S}/volyear/score3y.json'))
tw = []
for r in csv.DictReader(open(sys.argv[2])):
    if r['list'] == 'top50' and r['version'] == 'live' and r['size'] == '2' and r['view'] == 'all':
        v = R.get('|'.join((r['date'], r['sym'], r['minute'], r['side'])))
        if v and v[0] and v[1]: tw.append((v[0] / v[1], float(r['ret']), r['alert'], r['date'], v[0], v[1]))
B = [(0, 1, '< 1'), (1, 2, '1-2'), (2, 3, '2-3'), (3, 4, '3-4'), (4, 6, '4-6'), (6, 10, '6-10'), (10, 1e9, '>= 10')]
def q(v, p): v = sorted(v); return v[min(len(v) - 1, int(p * len(v)))]
def table(name, rows):
    print(f'\n{name}: {len(rows)} trades')
    print('| Score | Trades | Share | Won | p25 | Median | p75 | Avg | +100% | +300% | Plan / shock |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for lo, hi, lab in B:
        g = [x for x in rows if lo <= x[0] < hi]
        if not g: continue
        r = [x[1] for x in g]
        print(f"| {lab} | {len(g)} | {len(g)/len(rows):.0%} | {sum(v > 0 for v in r)/len(r):.0%} | {q(r,.25):+.0%} | {st.median(r):+.0%} | {q(r,.75):+.0%} | {st.mean(r):+.0%} | {sum(v >= 1 for v in r)} | {sum(v >= 3 for v in r)} | {sum(x[2]=='plan' for x in g)} / {sum(x[2]=='shock' for x in g)} |")
table('Live code year', live)
table('3 years', tw)
table('3 years without 10 Oct 2025', [x for x in tw if x[3] != '2025-10-10'])
print('\n10-10 trades:', ', '.join(f"{x[0]:.1f} ({x[1]:+.0%})" for x in sorted(tw, key=lambda x: x[0]) if x[3] == '2025-10-10'))
for name, rows in (('live', live), ('3y', tw)):
    print(f"{name}: stock ratio median {st.median(x[4] for x in rows):.1f}, SPY ratio median {st.median(x[5] for x in rows):.2f}")
