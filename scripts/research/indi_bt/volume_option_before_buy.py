# The user, 2026-11-02: "give me data on the option price - the size of it before the alert/bought 1-5-10-15 minutes by
# destribution". Volume 1.1.0 live-code year (pr_ parts), the 145 trades the live account takes; the bought contract's
# mid (Databento book, row m = the book as minute m began) at the buy minute and 1 / 5 / 10 / 15 minutes before.
import json, os, sqlite3, gzip, base64, statistics as st
from datetime import date as D
db = sqlite3.connect('volyear/d1.sqlite')
taken = set(json.load(open('volyear/taken_ids.json')))
rows = []
for f in sorted(os.listdir('volyear/parts')):
    if not f.startswith('pr_'): continue
    for s in json.load(open('volyear/parts/' + f))['signals']:
        t = s.get('trade')
        if not t or s['id'] not in taken: continue
        q = db.execute("select quotes from option_quotes where contract=? and date=? order by source limit 1", (t['contract'], s['date'])).fetchone()
        q = json.loads(gzip.decompress(base64.b64decode(q[0][3:]))) if q else []
        def mid(m):
            best = None
            for r in q:
                if r[0] > m: break
                best = r
            return (best[1] + best[2]) / 2 if best and m - best[0] < 5 and best[2] > 0 else None
        m = t['buyMinute']
        ret = (t['sell'] * 100 - 0.62) / (t['buy'] * 100 + 0.62) - 1
        rows.append({'id': s['id'], 'kind': s['kind'], 'date': s['date'], 'ret': ret, 'buy': t['buy'], 'm0': mid(m), **{f'm{k}': mid(m - k) for k in (1, 5, 10, 15)}})
print(len(rows), 'trades; with a book at the buy minute:', sum(r['m0'] is not None for r in rows))
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
pct = lambda x: f'{100 * x:+.0f}%'
def q(v, p): v = sorted(v); return v[min(len(v) - 1, int(p * len(v)))]
print('\nA. The option price (mid) before the buy: paid price vs k minutes before')
print('   k     n   p10    p25    median  p75    p90    | median price then -> paid')
for k in (1, 5, 10, 15):
    ch = [r['buy'] / r[f'm{k}'] - 1 for r in rows if r[f'm{k}']]
    pr = [r[f'm{k}'] for r in rows if r[f'm{k}']]
    print(f'  {k:2d}m  {len(ch):3d}  ' + '  '.join(f'{pct(q(ch, p)):>6}' for p in (.1, .25, .5, .75, .9)) + f'  | ${st.median(pr):.2f} -> ${st.median([r["buy"] for r in rows if r[f"m{k}"]]):.2f}')
print('\nB. Buckets of the rise in the 5 / 15 minutes before, and how the trade did (median, won, +300%, avg)')
for k in (1, 5, 10, 15):
    print(f'  {k} minutes before:')
    for lo, hi, name in ((-9, 0, 'flat or down'), (0, .25, '0 to +25%'), (.25, .5, '+25 to +50%'), (.5, 1, '+50 to +100%'), (1, 99, '+100% or more')):
        g = [r for r in rows if r[f'm{k}'] and lo <= r['buy'] / r[f'm{k}'] - 1 < hi]
        if not g: continue
        out = []
        for h in ('tune', 'check'):
            x = [r['ret'] for r in g if half(r['date']) == h]
            out.append(f"{h} n{len(x):3d} med {pct(st.median(x)) if x else '-':>5} avg {pct(st.mean(x)) if x else '-':>6} big {sum(v >= 3 for v in x)}")
        a = [r['ret'] for r in g]
        print(f'    {name:14s} n{len(g):3d} won {sum(v > 0 for v in a) / len(a):.0%} med {pct(st.median(a)):>5} avg {pct(st.mean(a)):>6} big {sum(v >= 3 for v in a)} | ' + ' | '.join(out))
print('\nC. Plan vs shock, median rise before the buy')
for kind in ('plan', 'shock'):
    print(f'  {kind}: ' + ', '.join(f"{k}m {pct(st.median([r['buy'] / r[f'm{k}'] - 1 for r in rows if r['kind'] == kind and r[f'm{k}']]))}" for k in (1, 5, 10, 15)))
