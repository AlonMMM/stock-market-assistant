# The 3-year research trades (the 10-30 dashboard's "Live (PR #204)" = Volume 1.1.0's twin, top 50 list, live limits,
# 2024-02 .. 2026-10) for two questions of 2026-11-02:
#  A. "against the last 1 hour" (look 3): skip a shock trade whose alert is against the stock's last-60-minute move >= 2 / 3 S30.
#  B. "how many bought we had in our 3 y test that are in the first 20 minutes? give me full report".
# The account is re-walked from the export's own dollar figures (each trade's P&L scaled by the account's size that day);
# a skipped trade's freed slot is not refilled (the export holds taken trades only).
import csv, json, sys, statistics as st
from collections import defaultdict
from datetime import date as D
from store import day
CSV, EV = sys.argv[1], sys.argv[2]
rows = [r for r in csv.DictReader(open(CSV)) if r['list'] == 'top50' and r['version'] == 'live' and r['view'] == 'all']
ev = defaultdict(list)
for e in json.load(open(EV)): ev[(e['sym'], e['date'])].append(e)
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'

def ctx(r):
    """The shock trade's alert (the last shock of the stock-day at or before the buy minute) and its moves, in S30."""
    m = int(r['minute'])
    al = [e for e in ev[(r['sym'], r['date'])] if e['m'] <= m]
    if not al: return None
    e = max(al, key=lambda e: e['sec0'])
    b = {x[0]: x for x in day(r['sym'], r['date'])}
    am = e['sec0'] // 60
    if am - 2 not in b or 0 not in b: return None
    up = e['stock0'] > b[am - 2][4]
    h1 = b[am - 61][4] if am - 61 in b else b[0][1]
    return {'up': up, 'hour': (e['stock0'] / h1 - 1) / e['u'], 'open': (e['stock0'] / b[0][1] - 1) / e['u'], 'am': am}

def walk(trades, size, skip=set()):
    tr = sorted([t for t in trades if t['size'] == size], key=lambda t: (t['date'], int(t['minute'])))
    eq0 = eq1 = 100_000.0
    peak, dd, base_day, new_day, cur = 1e5, 0.0, 1e5, 1e5, None
    out = {'tune': 0.0, 'check': 0.0}
    for t in tr:
        if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
        p = float(t['pnl'])
        eq0 += p
        if t['key'] in skip: continue
        q = p * new_day / base_day
        eq1 += q
        out[half(t['date'])] += q
        peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
    return eq1, dd, out

sizes = {s: [r | {'size': s} for r in rows if r['size'] == s] for s in ('2', '3')}
for s in sizes:
    for r in sizes[s]: r['key'] = (r['date'], r['sym'], r['minute'], r['side'])
two = sizes['2']
shock = [r for r in two if r['alert'] == 'shock']
miss = 0
for r in shock:
    r['c'] = ctx(r)
    miss += r['c'] is None
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1000:.1f}K"
pct = lambda x: f"{100 * x:+.0f}%"
def line(name, skip):
    e2, d2, h = walk(two, '2', skip); e3, d3, _ = walk(sizes['3'], '3', skip)
    kept = sorted([float(r['pnl']) for r in two if r['key'] not in skip], reverse=True)
    print(f"{name:52s} {len(two) - len(skip & {r['key'] for r in two}):4d}t ${e2/1e3:6.1f}K dd {100*d2:4.1f}%  (3% ${e3/1e3:6.1f}K dd {100*d3:4.1f}%)  tune {k(h['tune'])} check {k(h['check'])}  w/o best 5 {k(sum(kept[5:]))}")
    return kept

print(f"A. 3-year research, top 50, Live (PR #204) = 1.1.0's twin: {len(two)} trades, {len(shock)} shock ({miss} without bars/alert)\n")
line('1.1.0 twin', set())
for ref, x in (('hour', 2), ('hour', 3), ('open', 2)):
    cut = {r['key'] for r in shock if r['c'] and abs(r['c'][ref]) >= x and (r['c'][ref] > 0) != r['c']['up']}
    line(f"against the {'last hour' if ref == 'hour' else 'move since the open'} >= {x} S30", cut)
    gone = [r for r in shock if r['key'] in cut]
    rets = sorted(float(r['ret']) for r in gone)
    by = defaultdict(list)
    for r in gone: by[r['date'][:4]].append(float(r['ret']))
    print(f"   skips {len(gone)}: flat $2K {k(2000 * sum(rets))}, median {pct(st.median(rets)) if rets else '-'}, won {sum(x > 0 for x in rets)}, +300%: {sum(x >= 3 for x in rets)}; "
          + ", ".join(f"{y} {len(v)} {k(2000 * sum(v))}" for y, v in sorted(by.items()))
          + "; best: " + ", ".join(f"{r['sym']} {r['date']} {pct(float(r['ret']))}" for r in sorted(gone, key=lambda r: -float(r['ret']))[:3]))
    if ref == 'hour' and x == 2:
        print("   all: " + "; ".join(f"{r['sym']} {r['date']} {r['time']} {'up' if r['c']['up'] else 'down'} hr {r['c']['hour']:+.1f} {pct(float(r['ret']))}" for r in sorted(gone, key=lambda r: r['date'])))

print("\nB. Bought in the first 20 minutes (09:30-09:49), same trades")
first = [r for r in two if int(r['minute']) < 20]
def stats(name, g):
    rets = sorted(float(r['ret']) for r in g)
    if not rets: print(f"   {name}: none"); return
    pn = sorted((float(r['pnl']) for r in g), reverse=True)
    print(f"   {name:26s} {len(g):4d} trades, won {sum(x > 0 for x in rets):3d} ({100 * sum(x > 0 for x in rets) / len(rets):.0f}%), avg {pct(st.mean(rets))}, median {pct(st.median(rets))}, "
          f"+100%: {sum(x >= 1 for x in rets)}, +300%: {sum(x >= 3 for x in rets)}, -80% or worse: {sum(x <= -0.8 for x in rets)}; flat $2K {k(2000 * sum(rets))}; at 2% {k(sum(pn))}, w/o best 5 {k(sum(pn[5:]))}")
stats('all 3 years, all day', two)
stats('first 20 min', first)
rest = [r for r in two if int(r['minute']) >= 20]
stats('after 09:50', rest)
for kind in ('plan', 'shock'): stats(f'first 20 min, {kind}', [r for r in first if r['alert'] == kind])
for y in ('2024', '2025', '2026'): stats(f'first 20 min, {y}', [r for r in first if r['date'][:4] == y])
for h in ('tune', 'check'): stats(f'first 20 min, {h}', [r for r in first if half(r['date']) == h])
for a, z in ((0, 5), (5, 10), (10, 15), (15, 20), (20, 30), (30, 60), (60, 120), (120, 400)):
    stats(f'minute {a}-{z} ({9 + (30 + a) // 60}:{(30 + a) % 60:02d})', [r for r in two if a <= int(r['minute']) < z])
line('\n   account without the first 20 minutes', {r['key'] for r in first})
print("\n   every first-20-minute trade (buy time, side, kind, contract buy -> sell, out, return, $ at 2%):")
for r in sorted(first, key=lambda r: r['date']):
    print(f"   {r['date']} {r['time']} {r['sym']:5s} {r['side']} {r['alert']:5s} {r['buy']:>6s} -> {r['sell']:>6s} out {r['out']}  {pct(float(r['ret'])):>6s}  {k(float(r['pnl']))}")
