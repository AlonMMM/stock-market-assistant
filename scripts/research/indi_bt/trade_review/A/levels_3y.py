"""Group A (levels), the 3-year research twin as a second look at the filter picks (2026-11-03).
The 10-30 dashboard's "Live (PR #204)" trades = Volume 1.1.0's twin (top 50, live limits, 2024-02 .. 2026-10, 431
trades), with 1.2.0's rule applied as a filter (no shock against the move since the open >= 2 S30, as
volume_against_hour_3y.py: 404 trades, $866.9K), then the year's picks as filters:
  A1 skip a plan trade with a level still ahead within 0.5 S30 (day so far, 15-min, yesterday's, 5-day)
  A3 (reference) A1 or a prior level just broken by <= 1.1 S30
  C1 skip a plan trade against the move since the open >= 2 S30
The twin's `minute` is the alert minute (checked against the year's parts); the buy's price = that minute's close moved
0.25 S30 the trade's way (the plan's 15-s side cross, confirmUnits 0.25; the export has no stock price), levels from the
minutes before the alert minute; the unit from the 5 sessions before (levels.ts). Filtered, not re-run: the account is re-walked from
the export's dollars; a skipped trade's slot is not refilled. Wait-for-confirmation (B) needs a re-priced buy: not here.
Run from the app repo root: python3 -I levels_3y.py <testA dir>   (reads data/local/x/bt/market.sqlite read-only)
"""
import csv, json, sys, os, math, sqlite3, statistics as st
from collections import defaultdict
from datetime import date as D
T = sys.argv[1]
db = sqlite3.connect('file:data/local/x/bt/market.sqlite?mode=ro', uri=True)
_c = {}
def day(sym, d):
    if (sym, d) not in _c:
        r = db.execute('SELECT bars FROM bars WHERE symbol=? AND date=?', (sym, d)).fetchone()
        _c[(sym, d)] = json.loads(r[0]) if r else []
    return _c[(sym, d)]
def prior(sym, d):
    ds = [x for (x,) in db.execute("SELECT date FROM bars WHERE symbol=? AND date<? AND length(bars)>10 ORDER BY date DESC LIMIT 5", (sym, d))]
    return list(reversed(ds)) if len(ds) == 5 else None
rows = [r for r in csv.DictReader(open(os.path.join(T, 'in/volume_trades.csv'))) if r['list'] == 'top50' and r['version'] == 'live' and r['view'] == 'all']
ev = defaultdict(list)
for e in json.load(open(os.path.join(T, 'in/eventse_shock15.json'))): ev[(e['sym'], e['date'])].append(e)
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
gaps = defaultdict(list)

def shock_open(r):
    """1.2.0's rule on a twin shock trade (as volume_against_hour_3y.py): True = 1.2.0 skips it."""
    m = int(r['minute'])
    al = [e for e in ev[(r['sym'], r['date'])] if e['m'] <= m]
    if not al: return False
    e = max(al, key=lambda e: e['sec0'])
    b = {x[0]: x for x in day(r['sym'], r['date'])}
    am = e['sec0'] // 60
    if am - 2 not in b or 0 not in b: return False
    up = e['stock0'] > b[am - 2][4]
    mv = (e['stock0'] / b[0][1] - 1) / e['u']
    return abs(mv) >= 2 and (mv > 0) != up

def feat(r):
    sym, d, m = r['sym'], r['date'], int(r['minute']); call = r['side'] == 'C'
    b = {x[0]: x for x in day(sym, d)}
    am = m
    if am not in b or 0 not in b: gaps['no stock bar at the alert'].append(r['key']); return None
    ps = prior(sym, d)
    if not ps: gaps['no 5 prior sessions'].append(r['key']); return None
    rets = []
    for x in ps:
        s = day(sym, x)
        rets += [math.log(s[j][4] / s[j - 1][4]) for j in range(1, len(s)) if s[j - 1][4] > 0 and s[j][4] > 0]
    if len(rets) < 500: gaps['unit: < 500 returns'].append(r['key']); return None
    mu = sum(rets) / len(rets); u = math.sqrt(sum((x - mu) ** 2 for x in rets) / len(rets)) * math.sqrt(30)
    p = b[am][4] * (1 + (0.25 if call else -0.25) * u)
    lv = {}
    pre = [x for x in b if x < am]
    if pre: lv['day'] = max(b[x][2] for x in pre) if call else min(b[x][3] for x in pre)
    if am >= 15: lv['15min'] = max(b[x][2] for x in b if x < 15) if call else min(b[x][3] for x in b if x < 15)
    y = day(sym, ps[-1]); lv['yday'] = max(v[2] for v in y) if call else min(v[3] for v in y)
    allv = [v for x in ps for v in day(sym, x)]; lv['5day'] = max(v[2] for v in allv) if call else min(v[3] for v in allv)
    x = {k: ((p / L - 1) if call else (1 - p / L)) / u for k, L in lv.items()}
    mv = (p / b[0][1] - 1) / u
    return {'x': x, 'mv_open': mv, 'up': call}

def walk(trades, size, skip=set()):
    tr = sorted([t for t in trades if t['size'] == size], key=lambda t: (t['date'], int(t['minute'])))
    eq0 = eq1 = 100_000.0
    peak, dd, base_day, new_day, cur = 1e5, 0.0, 1e5, 1e5, None
    out = {'tune': 0.0, 'check': 0.0}; kept = []; yr = defaultdict(float); ten = 0.0
    for t in tr:
        if t['date'] != cur: cur, base_day, new_day = t['date'], eq0, eq1
        p = float(t['pnl']); eq0 += p
        if t['key'] in skip: continue
        q = p * new_day / base_day; eq1 += q
        out[half(t['date'])] += q; yr[t['date'][:4]] += q; kept.append((q, float(t['ret']), t['date']))
        if t['date'] == '2025-10-10': ten += q
        peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
    return eq1, dd, out, kept, yr, ten

sizes = {s: [dict(r, size=s) for r in rows if r['size'] == s] for s in ('2', '3')}
for s in sizes:
    for r in sizes[s]: r['key'] = (r['date'], r['sym'], r['minute'], r['side'])
two = sizes['2']
skip12 = {r['key'] for r in two if r['alert'] == 'shock' and shock_open(r)}
F = {}
for r in two:
    if r['alert'] == 'plan': F[r['key']] = feat(r)
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.1f}K"
def near_under(f): return f and any(-0.5 <= x < 0 for x in f['x'].values())
def near_any(f): return f and (near_under(f) or any(0 <= x <= 1.1 for n, x in f['x'].items() if n != 'day'))
def against(f): return f and abs(f['mv_open']) >= 2 and (f['mv_open'] > 0) != f['up']
V = [('1.1.0 twin', set()), ('1.2.0 twin (filter)', skip12),
     ('A1 skip under a level (0.5)', skip12 | {k_ for k_, f in F.items() if near_under(f)}),
     ('A3 skip near (reference)', skip12 | {k_ for k_, f in F.items() if near_any(f)}),
     ('C1 no plan against the open >= 2', skip12 | {k_ for k_, f in F.items() if against(f)})]
print(f"3-year twin: {len(two)} trades ({sum(r['alert'] == 'plan' for r in two)} plan); 1.2.0 filter skips {len(skip12)} shock trades; plan trades without level data: "
      + ", ".join(f"{g} {len(v)}" for g, v in gaps.items()) + " (kept, not near)")
print("| Version | Trades | 2% (drop) | 3% (drop) | Tune / check P&L (2%) | Median trade tune / check | Giants tune / check | Non-giant sum tune / check | 2024 / 2025 / 2026 | W/o best 5 | 2025-10-10 P&L | Without 10-10 (2%) |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
basekept = None
for name, sk in V:
    e2, d2, h, kept, yr, ten = walk(two, '2', sk); e3, d3, h3, *_ = walk(sizes['3'], '3', sk)
    pn = sorted((q for q, _, _ in kept), reverse=True)
    med = {hh: st.median([r_ for q, r_, d in kept if half(d) == hh]) for hh in ('tune', 'check')}
    gi = {hh: sum(1 for q, r_, d in kept if half(d) == hh and r_ >= 3) for hh in ('tune', 'check')}
    ng = {hh: sum(q for q, r_, d in kept if half(d) == hh and r_ < 3) for hh in ('tune', 'check')}
    print(f"| {name} | {len(kept)} | ${e2/1e3:.1f}K ({100*d2:.1f}%) | ${e3/1e3:.1f}K ({100*d3:.1f}%) | {k(h['tune'])} / {k(h['check'])} | {100*med['tune']:+.0f}% / {100*med['check']:+.0f}% | "
          f"{gi['tune']} / {gi['check']} | {k(ng['tune'])} / {k(ng['check'])} | {k(yr['2024'])} / {k(yr['2025'])} / {k(yr['2026'])} | {k(sum(pn[5:]))} | {k(ten)} | {k(e2 - 1e5 - ten)} |")
for name, sk in V[2:]:
    gone = [r for r in two if r['key'] in sk - skip12]
    rets = sorted(float(r['ret']) for r in gone)
    by = defaultdict(list)
    for r in gone: by[(r['date'][:4], half(r['date']))].append(float(r['ret']))
    print(f"\n{name}: skips {len(gone)} plan trades: flat $2K {k(2000*sum(rets))}, median {100*st.median(rets):+.0f}%, won {sum(x>0 for x in rets)}, +300% {sum(x>=3 for x in rets)}; "
          + "; ".join(f"{y} {hh} {len(v)} {k(2000*sum(v))}" for (y, hh), v in sorted(by.items()))
          + "\n   best: " + ", ".join(f"{r['sym']} {r['date']} {100*float(r['ret']):+.0f}%" for r in sorted(gone, key=lambda r: -float(r['ret']))[:5])
          + "\n   on 2025-10-10: " + (", ".join(f"{r['sym']} {100*float(r['ret']):+.0f}%" for r in gone if r['date'] == '2025-10-10') or 'none'))
    if name.startswith('C1') or name.startswith('A1'):
        q = [r for r in gone if r['sym'] == 'QCOM' and r['date'] == '2025-10-27']
        print('   QCOM 2025-10-27 (the user\'s example):', 'skipped' if q else 'not skipped', [r['key'] for r in two if r['sym'] == 'QCOM' and r['date'] == '2025-10-27'], 'put feat', F.get(('2025-10-27', 'QCOM', '88', 'P')))
