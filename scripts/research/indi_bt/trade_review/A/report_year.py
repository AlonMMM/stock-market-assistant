"""The fixed table from acct_out.json (acct.ts): tune for every version, the pick per idea on tune (by the 2% end), the
check for the base and the picks only; per half the median trade, the giants (>= +300%), the non-giant sum, by year,
without the best 5; what each pick removed. Run: python3 -I report_year.py <testA dir>"""
import json, sys, os, statistics as st
T = sys.argv[1]
A = {r['name']: r for r in json.load(open(os.path.join(T, 'acct_out.json')))}
M = {m['name']: m for m in json.load(open(os.path.join(T, 'mods.json')))}
info = json.load(open(os.path.join(T, 'feats.json')))['info']
F = json.load(open(os.path.join(T, 'feats.json')))['F']
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.1f}K"
def row(name, view):
    v2, v3 = A[name]['views'][view]['2'], A[name]['views'][view]['3']
    tr = v2['trades']; p = sorted((t['pnl'] for t in tr), reverse=True); r = [t['ret'] for t in tr]
    g = [t for t in tr if t['ret'] >= 3]
    yr = {y: sum(t['pnl'] for t in tr if t['date'][:4] == y) for y in ('2025', '2026')}
    return (f"| {name} | {len(tr)} | ${v2['end']/1e3:.1f}K ({v2['dd']:.1f}%) | ${v3['end']/1e3:.1f}K ({v3['dd']:.1f}%) | "
            f"{100*st.median(r):+.0f}% | {len(g)} | {k(sum(t['pnl'] for t in tr if t['ret'] < 3))} | {k(yr['2025'])} / {k(yr['2026'])} | {k(sum(p[5:]))} |")
H = "| Version | Trades | 2% (drop) | 3% (drop) | Median trade | Giants (>= +300%) | Non-giant sum (2%) | 2025 / 2026 (2%) | W/o best 5 (2%) |\n|---|---|---|---|---|---|---|---|---|"
names = [n for n in A if n != '1.1.0 (reference)']
print('TUNE (even ISO weeks), 1.2.0 live-code year 2025-11-03 .. 2026-10-30, 51 stocks, live limits, real books\n' + H)
for n in ['1.1.0 (reference)'] + names: print(row(n, 'tune'))
picks = {}
for idea in ('A', 'B', 'C'):
    c = [n for n in names if info.get(n, {}).get('idea') == idea]
    picks[idea] = max(c, key=lambda n: A[n]['views']['tune']['2']['end'])
print('\nPicks on tune (🎯):', picks)
print('\nCHECK (odd ISO weeks), the base and the picks only\n' + H)
for n in ['1.2.0 (base)', 'B0 control: near plan trades re-priced by minutes, no wait'] + list(picks.values()): print(row(n, 'check'))
print('\nYEAR\n' + H)
for n in ['1.2.0 (base)'] + list(picks.values()): print(row(n, 'year'))
base = {t['id']: t for t in A['1.2.0 (base)']['views']['year']['2']['trades']}
for n in list(picks.values()) + ['A3 skip near (under or just broke)']:
    mine = {t['id']: t for t in A[n]['views']['year']['2']['trades']}
    gone = [base[i] for i in base if i not in mine]; new = [mine[i] for i in mine if i not in base]
    changed = [(base[i], mine[i]) for i in mine if i in base and abs(mine[i]['ret'] - base[i]['ret']) > 1e-9]
    def d(ts):
        r = sorted(t['ret'] for t in ts)
        return f"{len(ts)}: flat $2K {k(2000*sum(r))}, median {100*st.median(r):+.0f}%, won {sum(x>0 for x in r)}, giants {sum(x>=3 for x in r)}" if r else '0'
    print(f"\n{n}\n  base trades gone {d(gone)}: " + ', '.join(f"{t['id'].split('|')[0]} {t['date']} {t['kind']} {100*t['ret']:+.0f}%" for t in sorted(gone, key=lambda t: t['date'])))
    print(f"  new trades (a later alert freed) {d(new)}: " + ', '.join(f"{t['id'].split('|')[0]} {t['date']} {100*t['ret']:+.0f}%" for t in new))
    if changed: print(f"  re-priced {len(changed)}: base {d([a for a, b in changed])} -> {d([b for a, b in changed])}")
    for h in ('tune', 'check'):
        ids = {t['id'] for t in A[n]['views'][h]['2']['trades']} if h in A[n]['views'] else set()
