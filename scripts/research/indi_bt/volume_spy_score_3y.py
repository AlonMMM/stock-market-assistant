# The user, 2026-11-02: "we can use it as a score ... if intl got 10X and spy 3X intel might be good bet ... double the
# premia". Score = the stock's 3-min volume ratio / SPY's (each vs its same-window median of 20 sessions). Sizes set
# before the run: x0.5 under 2, x1 2-6, x2 at >= 6 (neighbours: x2 at >= 4 / >= 10; and no half). 3-year twin (scaled
# walk; ratios at the window ending the minute before the buy), with and without 10 Oct 2025, vs the flat size at the
# same worst drop. The live code's year is score_acct_year.ts.
import csv, sys, json, statistics as st
from datetime import date as D
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
allr = [r for r in csv.DictReader(open(sys.argv[1])) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] in ('2', '3')]
R = json.load(open(sys.argv[2]))
def score(t):
    v = R.get('|'.join((t['date'], t['sym'], t['minute'], t['side'])))
    return v[0] / v[1] if v and v[0] and v[1] else None
def tiers(lo, hi, low=0.5):
    def f(t):
        s = score(t)
        if s is None: return 1
        if s >= hi: return 2
        if s < lo: return low
        return 1
    return f
def walk(view, size, f):
    tr = sorted([t for t in allr if t['view'] == view and t['size'] == size], key=lambda t: (t['date'], int(t['minute'])))
    cap = 5 / (2 if size == '2' else 3)
    eq0 = eq1 = 1e5; peak, dd, cur = 1e5, 0.0, None; out = {'tune': 0.0, 'check': 0.0}; qa = []
    for t in tr:
        if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
        p = float(t['pnl']); eq0 += p
        q = p * min(f(t), cap) * new_day / base_day
        eq1 += q; out[half(t['date'])] += q; qa.append(q); peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
    qa.sort(reverse=True)
    return eq1, dd, out, sum(qa[5:])
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.0f}K"
two = [t for t in allr if t['view'] == 'all' and t['size'] == '2']
sc = [score(t) for t in two if score(t)]
print(f"score at the buy: median {st.median(sc):.1f}, < 2: {sum(s < 2 for s in sc)}, 2-6: {sum(2 <= s < 6 for s in sc)}, >= 6: {sum(s >= 6 for s in sc)} of {len(sc)}")
for name, lo, hi in (('< 2', 0, 2), ('2-4', 2, 4), ('4-6', 4, 6), ('6-10', 6, 10), ('>= 10', 10, 1e9)):
    for view in ('all', 'wo'):
        g = [t for t in allr if t['view'] == view and t['size'] == '2' and score(t) is not None and lo <= score(t) < hi]
        out = []
        for h in ('tune', 'check'):
            x = [float(t['ret']) for t in g if half(t['date']) == h]
            out.append(f"{h} n{len(x)} med {100*st.median(x):+.0f}% avg {100*st.mean(x):+.0f}% big {sum(v >= 3 for v in x)}" if x else f'{h} -')
        print(f"  score {name:6s} {view:3s} " + ' | '.join(out))
V = [('1.1.0 twin', lambda t: 1), ('x0.5 < 2, x2 >= 6', tiers(2, 6)), ('  x0.5 < 2, x2 >= 4', tiers(2, 4)), ('  x0.5 < 2, x2 >= 10', tiers(2, 10)), ('  x2 >= 6 only', tiers(0, 6, 1)), ('  x0.5 < 2 only', tiers(2, 1e9))]
for view in ('all', 'wo'):
    print('\n' + ('all days' if view == 'all' else 'without 10 Oct 2025'))
    for name, f in V:
        e, d, h, w = walk(view, '2', f); e3, d3, _, _ = walk(view, '3', f)
        line = f"  {name:22s} 2%: ${e/1e3:5.0f}K dd {100*d:4.1f}% tune {k(h['tune']):>6} check {k(h['check']):>6} w/o5 {k(w):>6} | 3%: ${e3/1e3:5.0f}K dd {100*d3:4.1f}%"
        if name != '1.1.0 twin':
            lo, hi = .3, 2.5
            for _ in range(30):
                m = (lo + hi) / 2
                if walk(view, '2', lambda t, m=m: m)[1] < d: lo = m
                else: hi = m
            fe, fd, fh, fw = walk(view, '2', lambda t: lo)
            line += f"\n  {'':22s}   flat {2*lo:.2f}%: ${fe/1e3:5.0f}K tune {k(fh['tune'])} check {k(fh['check'])} w/o5 {k(fw)}"
        print(line)
