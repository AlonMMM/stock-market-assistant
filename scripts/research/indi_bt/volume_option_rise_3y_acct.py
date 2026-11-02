# The 3-year twin with the size set by the option's rise (ask, 5 min before the buy): half over +200% (300 / 400
# neighbours), skip over +500% / +600%; no book then -> unchanged. Scaled walk (each trade's P&L x the size x equity
# ratio), tune = even ISO weeks; with and without 10 Oct 2025; against the flat size with the same worst drop.
import csv, sys, json
from datetime import date as D
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
allr = [r for r in csv.DictReader(open(sys.argv[1])) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] in ('2', '3')]
R = json.load(open(sys.argv[2]))
rise = lambda t: (R.get('|'.join((t['date'], t['sym'], t['minute'], t['side']))) or {}).get('5')
def walk(view, size, f):
    tr = sorted([t for t in allr if t['view'] == view and t['size'] == size], key=lambda t: (t['date'], int(t['minute'])))
    eq0 = eq1 = 1e5; peak, dd, cur = 1e5, 0.0, None; out = {'tune': 0.0, 'check': 0.0}; qa = []; n = 0
    for t in tr:
        if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
        p = float(t['pnl']); eq0 += p
        x = f(t); n += x != 1
        q = p * x * new_day / base_day
        eq1 += q; out[half(t['date'])] += q; qa.append(q); peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
    qa.sort(reverse=True)
    return eq1, dd, out, sum(qa[5:]), n
def over(cut, x):
    return lambda t: x if (rise(t) or 0) > cut else 1
V = [('1.1.0 twin', lambda t: 1), ('half > +200%', over(2, .5)), ('half > +300%', over(3, .5)), ('half > +400%', over(4, .5)),
     ('skip > +500%', over(5, 0)), ('skip > +600%', over(6, 0))]
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.0f}K"
for view in ('all', 'wo'):
    print('\n' + ('all days' if view == 'all' else 'without 10 Oct 2025'))
    for name, f in V:
        e, d, h, w, n = walk(view, '2', f); e3, d3, h3, _, _ = walk(view, '3', f)
        line = f"  {name:14s} {n:3d} changed  2%: ${e/1e3:5.0f}K dd {100*d:4.1f}% tune {k(h['tune']):>6} check {k(h['check']):>6} w/o5 {k(w):>6} | 3%: ${e3/1e3:5.0f}K dd {100*d3:4.1f}%"
        if name != '1.1.0 twin':
            lo, hi = .3, 1.5
            for _ in range(30):
                mid = (lo + hi) / 2
                if walk(view, '2', lambda t, m=mid: m)[1] < d: lo = mid
                else: hi = mid
            fe, fd, fh, fw, _ = walk(view, '2', lambda t: lo)
            line += f"\n  {'':14s}   flat {2*lo:.2f}%: ${fe/1e3:5.0f}K tune {k(fh['tune'])} check {k(fh['check'])} w/o5 {k(fw)}"
        print(line)
gone = sorted([t for t in allr if t['view'] == 'all' and t['size'] == '2' and (rise(t) or 0) > 2], key=lambda t: -float(t['ret']))
print(f"\nover +200%: {len(gone)} trades, won {sum(float(t['ret']) > 0 for t in gone)}, +300%: {sum(float(t['ret']) >= 3 for t in gone)}, median {sorted(float(t['ret']) for t in gone)[len(gone)//2]:+.0%}")
print('  best: ' + ', '.join(f"{t['sym']} {t['date']} {t['alert']} rise {100*rise(t):+.0f}% ret {100*float(t['ret']):+.0f}% {half(t['date'])}" for t in gone[:8]))
for y in ('2024', '2025', '2026'):
    g = [float(t['ret']) for t in gone if t['date'][:4] == y]
    print(f"  {y}: {len(g)} trades, won {sum(x > 0 for x in g)}, sum at $2K {k(2000 * sum(g))}")
