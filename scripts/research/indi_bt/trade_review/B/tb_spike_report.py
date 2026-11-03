# testB (2026-11-03), group B "buying the spike itself" on Volume 1.2.0 (live since 2026-11-03), the app engine's year
# 2025-11-03 .. 2026-10-30, 51 stocks, saved limits, real books only, no broker stop. The account = backtest.ts
# volumeAccount (ported, checked to the dollar on the 1.2.0 parts). Tune = even ISO entry weeks, check = odd.
# Ideas (levels set before the run):
#   A wait W s after the side, buy only if the move holds (engine re-run, TB_DELAY): d60 (line), d120, d60a (alert price), d60p (plan only)
#   B skip a huge alert minute: option paid >= K x its mid a minute earlier (K 3; 2, 5; 3 plan-only);
#     the stock's 60-s move >= N x its usual 60-s move (N 10; 6, 15)
#   C skip an SPY-driven move: SPY's 60-s move the trade's way >= X (0.15%; 0.10%, 0.25%; 0.15% plan-only);
#     beta x SPY's 60-s move >= S of the stock's own 60-s move (S 0.5; 0.33, 0.67)
# Usage: python3 tb_spike_report.py <testB dir>
import sys, os, json, glob, statistics as st
from datetime import date as D
T = sys.argv[1]
L = json.load(open(f'{T}/settings.json'))
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
def sigs(prefix, d=None):
    d = d or f'{T}/runs/parts'
    out = []
    for f in sorted(glob.glob(f'{d}/{prefix}_*.json')): out += json.load(open(f))['signals']
    return out
def ret(t): return (t['sell'] * 100 - 0.62) / (t['buy'] * 100 + 0.62) - 1
def account(S, pct):
    by = {}
    for s in S:
        if s.get('trade'): by.setdefault((s['date'], s['symbol']), []).append(s)
    kept = []
    for lst in by.values():
        busy, n = -1, 0
        for s in sorted(lst, key=lambda s: s['second']):
            t = s['trade']
            if t['buyMinute'] <= busy or n >= L['maxPerStock']: continue
            kept.append(s); busy = t['exitMinute']; n += 1
    days = {}
    for s in kept: days.setdefault(s['date'], []).append(s)
    eq = peak = 1e5; drop = 0; taken = []
    for d in sorted(days):
        start = eq; done = []; today = []
        for s in sorted(days[d], key=lambda s: (s['trade']['buyMinute'], s['minute'])):
            t = s['trade']
            if sum(x[1] for x in done if x[0] < t['buyMinute']) <= -L['dayLossPct'] / 100 * start: continue
            if len(done) >= L['maxTradesPerDay']: continue
            if sum(1 for x in done if x[0] >= t['buyMinute']) >= L['maxOpen']: continue
            q = int(pct / 100 * start // (t['buy'] * 100))
            if q < 1: continue
            pnl = q * (t['sell'] - t['buy']) * 100 - 0.62 * 2 * q
            done.append((t['exitMinute'], pnl)); today.append((s, pnl))
        for s, pnl in sorted(today, key=lambda x: x[0]['trade']['exitMinute']):
            eq += pnl; peak = max(peak, eq); drop = max(drop, 1 - eq / peak)
        taken += today
    return eq, drop * 100, taken
K = lambda n: f"${n / 1e3:.1f}K"
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.1f}K"
def stats(S, view):
    V = [s for s in S if view == 'year' or half(s['date']) == view]
    e2, d2, tk = account(V, 2); e3, d3, _ = account(V, 3)
    p = sorted((x[1] for x in tk), reverse=True)
    r = [ret(x[0]['trade']) for x in tk]
    giants = [x for x in tk if ret(x[0]['trade']) >= 3]
    return dict(n=len(tk), won=sum(x[1] > 0 for x in tk), med=st.median(r) if r else 0, e2=e2, d2=d2, e3=e3, d3=d3,
                wo5=sum(p[5:]), nongiant=sum(x[1] for x in tk if ret(x[0]['trade']) < 3), giants=len(giants),
                y25=sum(x[1] for x in tk if x[0]['date'] < '2026'), y26=sum(x[1] for x in tk if x[0]['date'] >= '2026'),
                flat=2000 * sum(r), ids={x[0]['id'] for x in tk}, tk=tk)
HEAD = "| Version | Trades | Won | Median trade | 2% (drop) | 3% (drop) | 2% w/o best 5 | Non-giant sum (2%) | Giants (>= +300%) | 2025 / 2026 (2%) | Flat $2K sum |\n|---|---|---|---|---|---|---|---|---|---|---|"
def line(name, x, base=None):
    vs = f" ({k(x['e2'] - base['e2'])})" if base else ''
    return (f"| {name} | {x['n']} | {x['won']} | {100 * x['med']:+.0f}% | {K(x['e2'])}{vs} ({x['d2']:.0f}%) | {K(x['e3'])} ({x['d3']:.0f}%) | "
            f"{k(x['wo5'])} | {k(x['nongiant'])} | {x['giants']} | {k(x['y25'])} / {k(x['y26'])} | {k(x['flat'])} |")
# ---- the versions ----
base = sigs('c0')
F = json.load(open(f'{T}/runs/features_c0.json'))['features']
def filt(pred, plan_only=False):
    def f(S):
        out = []
        for s in S:
            if s.get('trade') and s['id'] in F and (not plan_only or s['kind'] == 'plan'):
                x = F[s['id']]
                if pred(x): s = {**s, 'trade': None, 'outcome': 'testB_skip'}
            out.append(s)
        return out
    return f
gt = lambda key, v: (lambda x: x.get(key) is not None and x[key] >= v)
VERS = [
    ('A', 'A wait 60 s, still past the side line', lambda: sigs('d60')),
    ('A', 'A wait 120 s, still past the side line', lambda: sigs('d120')),
    ('A', 'A wait 60 s, still past the alert price', lambda: sigs('d60a')),
    ('A', 'A wait 60 s past the line, plan alerts only', lambda: sigs('d60p')),
    ('B', 'B option >= 3x its mid a minute earlier', lambda: filt(gt('opt_rise', 3))(base)),
    ('B', 'B option >= 2x', lambda: filt(gt('opt_rise', 2))(base)),
    ('B', 'B option >= 5x', lambda: filt(gt('opt_rise', 5))(base)),
    ('B', 'B option >= 3x, plan alerts only', lambda: filt(gt('opt_rise', 3), True)(base)),
    ('B', 'B stock 60-s move >= 10x usual', lambda: filt(gt('move_x', 10))(base)),
    ('B', 'B stock 60-s move >= 6x usual', lambda: filt(gt('move_x', 6))(base)),
    ('B', 'B stock 60-s move >= 15x usual', lambda: filt(gt('move_x', 15))(base)),
    ('C', 'C SPY 60-s move our way >= 0.15%', lambda: filt(gt('r_spy', 0.0015))(base)),
    ('C', 'C SPY >= 0.10%', lambda: filt(gt('r_spy', 0.0010))(base)),
    ('C', 'C SPY >= 0.25%', lambda: filt(gt('r_spy', 0.0025))(base)),
    ('C', 'C SPY >= 0.15%, plan alerts only', lambda: filt(gt('r_spy', 0.0015), True)(base)),
    ('C', 'C beta x SPY >= 50% of the stock move', lambda: filt(gt('spy_share', 0.5))(base)),
    ('C', 'C beta x SPY >= 33%', lambda: filt(gt('spy_share', 0.33))(base)),
    ('C', 'C beta x SPY >= 67%', lambda: filt(gt('spy_share', 0.67))(base)),
]
res = {'tune': {}, 'check': {}, 'year': {}}
champ = {v: stats(base, v) for v in res}
out = []
out.append(f"Champion reproduction (Volume 1.2.0, year, 2%): {K(champ['year']['e2'])} ({champ['year']['d2']:.1f}%), {champ['year']['n']} trades; tune {K(champ['tune']['e2'])}, check {K(champ['check']['e2'])}")
out.append('\n### Tune (even ISO entry weeks)\n' + HEAD)
out.append(line('Volume 1.2.0 (live)', champ['tune']))
cache = {}
for idea, name, fn in VERS:
    cache[name] = fn()
    res['tune'][name] = stats(cache[name], 'tune')
picks = {}
for idea in ('A', 'B', 'C'):
    # the pick: the most money at 2% on tune, among versions with no deeper drop than the champion + 2 points
    cands = [(name, res['tune'][name]) for i, name, _ in VERS if i == idea]
    ok = [c for c in cands if c[1]['d2'] <= champ['tune']['d2'] + 2] or cands
    picks[idea] = max(ok, key=lambda c: c[1]['e2'])[0]
for idea, name, _ in VERS:
    out.append(line(('🎯 ' if picks[idea] == name else '') + name, res['tune'][name], champ['tune']))
# Added after the run (not in the pick): the plan-only neighbours of the C pick, tune only, to see a knife edge.
out.append("\nAdded after the run, tune only (not candidates for the pick): the C pick's plan-only neighbours")
for name, fn in [('C SPY >= 0.10%, plan alerts only', lambda: filt(gt('r_spy', 0.0010), True)(base)),
                 ('C SPY >= 0.25%, plan alerts only', lambda: filt(gt('r_spy', 0.0025), True)(base))]:
    out.append(line(name, stats(fn(), 'tune'), champ['tune']))
out.append('\n### Check (odd ISO entry weeks): the champion and the picks only\n' + HEAD)
out.append(line('Volume 1.2.0 (live)', champ['check']))
for idea in ('A', 'B', 'C'):
    n = picks[idea]; res['check'][n] = stats(cache[n], 'check')
    out.append(line('🎯 ' + n, res['check'][n], champ['check']))
out.append('\n### Year (both halves), champion and picks\n' + HEAD)
out.append(line('Volume 1.2.0 (live)', champ['year']))
for idea in ('A', 'B', 'C'):
    n = picks[idea]; res['year'][n] = stats(cache[n], 'year')
    out.append(line('🎯 ' + n, res['year'][n], champ['year']))
# without the best 5 on each half, picks
out.append('\n### Without the best 5 (2%), tune / check')
for name in ['Volume 1.2.0 (live)'] + [picks[i] for i in 'ABC']:
    a = champ if name.startswith('Volume') else None
    t = (champ['tune'] if a else res['tune'][name]); c = (champ['check'] if a else res['check'][name])
    out.append(f"- {name}: tune {k(t['wo5'])}, check {k(c['wo5'])}; median tune {100*t['med']:+.0f}% / check {100*c['med']:+.0f}%; non-giant tune {k(t['nongiant'])} / check {k(c['nongiant'])}; giants {t['giants']} / {c['giants']}")
# what each version changed (trades, before the account): removed / added vs the champion's traded alerts
out.append('\n### What each version changed (traded alerts before the account, flat returns)')
bt = {s['id']: s for s in base if s.get('trade')}
for idea, name, _ in VERS:
    S = cache[name]; vt = {s['id']: s for s in S if s.get('trade')}
    gone = [bt[i] for i in bt if i not in vt]; new = [vt[i] for i in vt if i not in bt]
    same = [i for i in vt if i in bt]
    rg = sorted(ret(s['trade']) for s in gone)
    line2 = f"- {name}: removed {len(gone)}"
    if rg: line2 += f" (median {100*st.median(rg):+.0f}%, tune/check {sum(half(s['date'])=='tune' for s in gone)}/{sum(half(s['date'])=='check' for s in gone)}, +300% {sum(r>=3 for r in rg)}, flat $2K {k(2000*sum(rg))}, w/o best 5 {k(2000*sum(rg[:-5]))})"
    if new: line2 += f"; new {len(new)}"
    if idea == 'A' and same:
        d = [ret(vt[i]['trade']) - ret(bt[i]['trade']) for i in same]
        pr = [vt[i]['trade']['buy'] / bt[i]['trade']['buy'] - 1 for i in same]
        rk = [ret(bt[i]['trade']) for i in same]; rd = [ret(vt[i]['trade']) for i in same]
        line2 += (f"; kept {len(same)}: price paid median {100*st.median(pr):+.0f}% vs the immediate buy, return median {100*st.median(rk):+.0f}% -> {100*st.median(rd):+.0f}%,"
                  f" flat $2K {k(2000*sum(rk))} -> {k(2000*sum(rd))}")
        tb = [s for s in S if s.get('outcome') == 'turned_back' and s['id'] in bt]
        rt = sorted(ret(s['trade'] if False else bt[s['id']]['trade']) for s in tb)
        if rt: line2 += f"; turned back {len(tb)} (their immediate-buy median {100*st.median(rt):+.0f}%, +300% {sum(r>=3 for r in rt)}, flat {k(2000*sum(rt))})"
        nf = [s for s in S if s.get('outcome') == 'no_fill' and s['id'] in bt]
        line2 += f"; no book at the delayed buy or sale {len(nf)}"
    out.append(line2)
# missing data
out.append('\n### Alerts with missing data')
def lacking(S): return [s for s in S if s['outcome'] in ('no_fill', 'no_prices', 'no_strikes') or (s['outcome'] == 'wide_spread' and s['detail'].startswith('no book'))]
for name, S in [('Volume 1.2.0 (live)', base)] + [(n, cache[n]) for _, n, _ in VERS if _ == 'A' or True][:4]:
    lk = lacking(S)
    by = {}
    for s in lk: by[s['outcome'] + (': ' + s['detail'].split(' (')[0] if s['outcome'] == 'no_fill' else '')] = by.get(s['outcome'] + (': ' + s['detail'].split(' (')[0] if s['outcome'] == 'no_fill' else ''), 0) + 1
    out.append(f"- {name}: {len(lk)} of {len(S)} alerts lack data: {by}")
M = json.load(open(f'{T}/runs/features_c0.json'))['missing']
out.append(f"- Filter features missing (trade kept, never dropped): {{k: len(v) for k, v in M.items()}} = { {k: len(v) for k, v in M.items()} }")
for idea in 'BC':
    n = picks[idea]; vt = {x['id'] for x in cache[n] if x.get('trade')}
    g = [bt[i] for i in bt if i not in vt]
    out.append(f"- {n} removes: " + ', '.join(f"{x['symbol']} {x['date']} {x['kind']} {x['trade']['right']} {100*ret(x['trade']):+.0f}% ({half(x['date'])})" for x in sorted(g, key=lambda x: x['date'])))
txt = '\n'.join(out)
print(txt)
open(f'{T}/report.md', 'w').write(txt)
json.dump({'picks': picks}, open(f'{T}/picks.json', 'w'))
