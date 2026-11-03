# The 3-year twin's dumps (scratch run3y.sh: leg_seconds.py run, the live twin's settings of 2026-10-30 with each
# f60_variants.py shock list as the shock tag) -> one row per version. python3 shock_variants_3y.py <dump dir>
import json, os, statistics as st, sys
from datetime import date as D
SC = sys.argv[1]
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
net = lambda b, s: (s * 100 - 0.62) / (b * 100 + 0.62) - 1
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1000:.1f}K"
def stats(T):
    T = sorted(T, key=lambda r: (r['date'], r['minute']))
    eq, peak, dd, h = 1e5, 1e5, 0.0, {'tune': 0.0, 'check': 0.0}
    for r in T:
        eq += r['pnl']; peak = max(peak, eq); dd = max(dd, 1 - eq / peak); h[half(r['date'])] += r['pnl']
    return eq, dd, h
NAMES = dict(live='1.1.0 twin (stored list, old picks)', base15='Live rule recomputed (15x)', u15p3='15x + 3x pace (candidate, exact)',
             u10p3='10x + 3x pace', u10p5='10x + 5x pace', s15p3='5-min avg 15x + 3x', s30p3='10-min avg 15x + 3x',
             m15='5-min avg 11.5x + 3x (count-matched)', m30='10-min avg 11x + 3x (count-matched)')
print('| Version | Trades (shock) | 2% (drop) | 3% (drop) | Tune 2% | Check 2% | 2% w/o best 5 | Shock median |')
print('|---|---|---|---|---|---|---|---|')
for v, name in NAMES.items():
    f2, f3 = f'{SC}/{v}/flat2_shock_30_burst_0.json', f'{SC}/{v}/flat3_shock_30_burst_0.json'
    if not os.path.exists(f2): continue
    T2, T3 = json.load(open(f2)), json.load(open(f3))
    e2, d2, h = stats(T2); e3, d3, _ = stats(T3)
    sh = [r for r in T2 if r['src'] != '3y50' and r['src'].startswith('e_')]
    best = sorted((r['pnl'] for r in T2), reverse=True)
    med = st.median(net(r['buy'], r['sell']) for r in sh) if sh else 0
    print(f"| {name} | {len(T2)} ({len(sh)}) | ${e2/1e3:.1f}K ({100*d2:.1f}%) | ${e3/1e3:.0f}K ({100*d3:.1f}%) | {k(h['tune'])} | {k(h['check'])} | {k(sum(best[5:]))} | {100*med:+.0f}% |")
