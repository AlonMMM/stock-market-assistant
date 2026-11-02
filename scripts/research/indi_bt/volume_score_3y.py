# The user, 2026-11-03: "call it volume score. and go". 3-year twin (top50, live), scaled walk at 2% (3% beside it).
# Rules set before the run: skip one tune-quintile band at a time, x0.5 / x2 by tune tertiles (both ways), and the
# earlier rules on the new score (skip 1-2, skip 1-3, x0.5 < 2 / x2 >= 6). Cuts from the tune weeks without 10-10.
# The pick = the best tune result without 10-10; its check is the verdict. A trade with no score keeps x1.
import csv, json, sys
from datetime import date as D
S = sys.argv[1]
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
R = json.load(open(f'{S}/volyear/volscore_twin.json'))
rows = [r for r in csv.DictReader(open(sys.argv[2])) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] in ('2', '3')]
def score(t):
    v = R.get('|'.join((t['date'], t['sym'], t['minute'], t['side'])))
    return v['score'] if v and v['score'] else None
def walk(view, size, mult, only=None):
    tr = sorted([t for t in rows if t['view'] == view and t['size'] == size], key=lambda t: (t['date'], int(t['minute'])))
    eq0 = eq1 = 1e5; peak, dd, cur = 1e5, 0.0, None; out = {'tune': 0.0, 'check': 0.0}; qa = {'tune': [], 'check': []}
    for t in tr:
        if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
        p = float(t['pnl']); eq0 += p
        s = score(t); x = mult(s) if s else 1
        x = min(x, 5 / int(size))
        if x == 0: continue
        q = p * x * new_day / base_day; eq1 += q; out[half(t['date'])] += q; qa[half(t['date'])].append(q)
        peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
    wo5 = {h: sum(sorted(v, reverse=True)[5:]) for h, v in qa.items()}
    return eq1, dd, out, wo5
tune = sorted(score(t) for t in rows if t['view'] == 'wo' and t['size'] == '2' and half(t['date']) == 'tune' and score(t))
qq = lambda p: tune[int(p * len(tune))]
Q = [0] + [qq(p) for p in (.2, .4, .6, .8)] + [1e9]
T1, T2 = qq(1 / 3), qq(2 / 3)
def band(lo, hi): return lambda s: 0 if lo <= s < hi else 1
def tiers(lo_x, hi_x): return lambda s: lo_x if s < T1 else (hi_x if s >= T2 else 1)
V = [('1.1.0 twin', lambda s: 1)]
V += [(f'skip quintile {i + 1} ({Q[i]:.1f}-{Q[i + 1]:.1f})', band(Q[i], Q[i + 1])) for i in range(5)]
V += [(f'x0.5 < {T1:.1f}, x2 >= {T2:.1f}', tiers(0.5, 2)), (f'x2 < {T1:.1f}, x0.5 >= {T2:.1f}', tiers(2, 0.5))]
V += [('skip 1-2', band(1, 2)), ('skip 1-3', band(1, 3)), ('x0.5 < 2, x2 >= 6', lambda s: 0.5 if s < 2 else (2 if s >= 6 else 1))]
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.0f}K"
print(f'tune quintile cuts {[round(x, 1) for x in Q[1:-1]]}, tertiles {T1:.1f} / {T2:.1f}, unscored trades {sum(1 for t in rows if t["view"] == "all" and t["size"] == "2" and not score(t))}')
res = {}
for view in ('all', 'wo'):
    print('\n' + ('all days' if view == 'all' else 'without 10 Oct 2025'))
    for name, f in V:
        e, d, h, w = walk(view, '2', f); e3, d3, _, _ = walk(view, '3', f)
        res[(view, name)] = (e, d, h, w)
        print(f"  {name:30s} 2%: ${e/1e3:5.0f}K dd {100*d:4.1f}% | tune {k(h['tune']):>6} w/o5 {k(w['tune']):>6} | check {k(h['check']):>6} w/o5 {k(w['check']):>6} | 3%: ${e3/1e3:5.0f}K dd {100*d3:4.1f}%")
pick = max(V[1:], key=lambda v: res[('wo', v[0])][2]['tune'])
print(f'\n🎯 pick on tune (without 10-10): {pick[0]}')
for view in ('all', 'wo'):
    e, d, h, w = res[(view, pick[0])]
    lo, hi = 0.2, 3.0
    for _ in range(30):
        m = (lo + hi) / 2
        if walk(view, '2', lambda s, m=m: m)[1] < d: lo = m
        else: hi = m
    fe, fd, fh, fw = walk(view, '2', lambda s: lo)
    print(f"  {view}: pick ${e/1e3:.0f}K dd {100*d:.1f}% tune {k(h['tune'])} check {k(h['check'])} (w/o5 {k(w['check'])}) | flat x{lo:.2f} same drop ${fe/1e3:.0f}K tune {k(fh['tune'])} check {k(fh['check'])} (w/o5 {k(fw['check'])})")
