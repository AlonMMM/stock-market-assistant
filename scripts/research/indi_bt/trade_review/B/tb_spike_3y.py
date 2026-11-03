# testB (2026-11-03): the picks of B and C on the 3-year research twin (the 10-30 dashboard's "Live (PR #204)" =
# Volume 1.1.0's twin, top 50, live limits, 2024-02 .. 2026-10, 431 trades; 1.2.0's shock rule not applied), to see
# 2025-10-10. Filtered, not re-run; the account re-walked from the export's dollars (volume_option_rise_3y_acct.walk),
# a skipped slot not refilled. The twin keeps only the buy minute m: plan buys come 0-17 s into m, so t = m*60 + 10;
# SPY's 60-s move from 10-s bars (bars-10s.sqlite, spy10s.sqlite). B's option rise: the paid price vs the ASK one
# minute before (volume_option_rise_3y.py's "1"), so 5x on the ask = a rise >= 4.0 (rougher than the year's mid).
# A (the delayed buy) is not run here: it needs the simulator re-run with books 1-2 minutes after each buy.
#   python3 tb_spike_3y.py <volume_trades.csv> <rise3y.json>
import csv, sys, json, os, sqlite3, statistics as st
from datetime import date as D, datetime
from zoneinfo import ZoneInfo
NY = ZoneInfo('America/New_York')
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
allr = [r for r in csv.DictReader(open(sys.argv[1])) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] in ('2', '3')]
R = json.load(open(sys.argv[2]))
MAIN = os.path.expanduser('~/Desktop/Personal/stock-market-assistant/data/local/bars-10s.sqlite')
SPY2 = '/private/tmp/claude-501/-Users-alonmo-Desktop-Personal-stock-market-assistant/6fb99457-9696-4e71-87a7-c3ad635440fb/scratchpad/spy10s.sqlite'
dbm = sqlite3.connect(f'file:{MAIN}?mode=ro', uri=True); dbs = sqlite3.connect(f'file:{SPY2}?mode=ro', uri=True)
def spy_at(d, t):
    db = dbm if '2025-10-23' <= d <= '2026-10-22' else dbs
    o = int(datetime.fromisoformat(d + 'T09:30').replace(tzinfo=NY).timestamp())
    r = db.execute("select close from bars where symbol='SPY' and start+10<=? and start>=? order by start desc limit 1", (o + t, o + t - 120)).fetchone()
    return r[0] if r else None
RS = {}
def r_spy(t):
    k = (t['date'], t['minute'])
    if k not in RS:
        s = int(t['minute']) * 60 + 10
        a, b = spy_at(t['date'], s), spy_at(t['date'], s - 60)
        RS[k] = (a / b - 1) if a and b else None
    v = RS[k]
    return None if v is None else (v if t['side'] == 'C' else -v)
rise = lambda t: (R.get('|'.join((t['date'], t['sym'], t['minute'], t['side']))) or {}).get('1')
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
C = lambda t: 0 if (t['alert'] == 'plan' and (r_spy(t) or 0) >= 0.0015) else 1
B = lambda t: 0 if (rise(t) or 0) >= 4.0 else 1
V = [('1.1.0 twin', lambda t: 1), ('C SPY 60-s >= 0.15% our way, plan only', C), ('B option >= 5x (ask, 1 min)', B)]
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.0f}K"
print('| View | Version | Skipped | 2% end (drop) | Tune | Check | W/o best 5 | 3% end (drop) |\n|---|---|---|---|---|---|---|---|')
for view in ('all', 'wo'):
    for name, f in V:
        e, d, h, w, n = walk(view, '2', f); e3, d3, _, _, _ = walk(view, '3', f)
        print(f"| {'all days' if view == 'all' else 'without 10 Oct 2025'} | {name} | {n} | ${e/1e3:.0f}K ({100*d:.1f}%) | {k(h['tune'])} | {k(h['check'])} | {k(w)} | ${e3/1e3:.0f}K ({100*d3:.1f}%) |")
for name, f in V[1:]:
    gone = [t for t in allr if t['view'] == 'all' and t['size'] == '2' and f(t) == 0]
    rr = sorted(float(t['ret']) for t in gone)
    if not rr: print(name, 'skips none'); continue
    print(f"\n{name}: {len(gone)} trades skipped, median {100*st.median(rr):+.0f}%, won {sum(x>0 for x in rr)}, +300% {sum(x>=3 for x in rr)}, "
          f"tune/check {sum(half(t['date'])=='tune' for t in gone)}/{sum(half(t['date'])=='check' for t in gone)}, on 2025-10-10 {sum(t['date']=='2025-10-10' for t in gone)}; "
          f"by year " + ', '.join(f"{y}: {sum(t['date'][:4]==y for t in gone)} (flat $2K {k(2000*sum(float(t['ret']) for t in gone if t['date'][:4]==y))})" for y in ('2024','2025','2026')))
    print('  best skipped: ' + ', '.join(f"{t['sym']} {t['date']} {100*float(t['ret']):+.0f}%" for t in sorted(gone, key=lambda t: -float(t['ret']))[:6]))
miss = sum(1 for t in allr if t['view'] == 'all' and t['size'] == '2' and t['alert'] == 'plan' and r_spy(t) is None)
print(f"\nplan trades with no SPY 10-s bar (kept): {miss}; trades with no 1-min ask (kept): {sum(1 for t in allr if t['view']=='all' and t['size']=='2' and rise(t) is None)}")
