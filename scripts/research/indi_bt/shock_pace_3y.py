# "A shock must also jump against the day" on the 3-year research twin (the user, 2026-11-02: "shock is a sadden
# increase in the volume. to not compare it to today volume is weird" ... "meanwhile you can ran the 5/3x with 15X on
# the 3 years dataset?"). The 10-30 dashboard's trades ("Live (PR #204)" = Volume 1.1.0's twin, top 50, live limits,
# 2024-02 .. 2026-10). A shock trade's alert (the last shock of the stock-day at or before the buy minute, from
# sec_cache/eventse_shock15.json) gets its 60-second volume against today's pace (packages/trading/src/strangle/fast.ts
# fastState: the zone from minute 30, measured from ~10:16) from the Mac's 10-second bars; under K x (K = 3, 5) the
# trade is skipped. Filtered, not re-run: a skipped alert's cooldown would free a later shock (the live-code year ran it
# exactly, volume-bot.md 2026-11-02); the account is re-walked from the export's dollars, a skipped slot not refilled
# (volume_against_hour_3y.walk).
#   python3 shock_pace_3y.py <volume_trades.csv> sec_cache/eventse_shock15.json <bars-10s.sqlite>
import csv, json, sqlite3, sys, statistics as st
from collections import defaultdict
from datetime import date as D, datetime
from zoneinfo import ZoneInfo
CSV, EV, BARS = sys.argv[1:4]
rows = [r for r in csv.DictReader(open(CSV)) if r['list'] == 'top50' and r['version'] == 'live' and r['view'] == 'all']
ev = defaultdict(list)
for e in json.load(open(EV)): ev[(e['sym'], e['date'])].append(e)
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
db = sqlite3.connect(f'file:{BARS}?mode=ro', uri=True)
SLOTS, W, PACE_FROM, PACE_TO = 2340, 6, 180, 2160
NY = ZoneInfo('America/New_York')

def volumes(sym, d):
    open_s = int(datetime.fromisoformat(d + 'T09:30').replace(tzinfo=NY).timestamp())
    v = [0] * SLOTS
    for start, vol in db.execute('SELECT start, volume FROM bars WHERE symbol = ? AND start >= ? AND start < ?', (sym, open_s, open_s + SLOTS * 10)):
        k = (start - open_s) // 10
        if 0 <= k < SLOTS: v[k] = vol
    return v

def pace(sym, d, sec0):
    """fastState's pace at the slot ending sec0: the window over today's zone average; None before it is measured."""
    v, t = volumes(sym, d), sec0 // 10 - 1
    win = sum(v[t - W + 1:t + 1])
    before = t - W
    if not (before >= PACE_FROM + 15 * 6 - 1 and t < PACE_TO): return None
    zone = sum(v[PACE_FROM:before + 1])
    avg = zone / (before - PACE_FROM + 1)
    return win / (avg * W) if avg > 0 else None

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
    al = [e for e in ev[(r['sym'], r['date'])] if e['m'] <= int(r['minute'])]
    r['pace'] = pace(r['sym'], r['date'], max(al, key=lambda e: e['sec0'])['sec0']) if al else None
    miss += not al
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1000:.1f}K"
pct = lambda x: f"{100 * x:+.0f}%"
def line(name, skip):
    e2, d2, h = walk(two, '2', skip); e3, d3, _ = walk(sizes['3'], '3', skip)
    kept = sorted([float(r['pnl']) for r in two if r['key'] not in skip], reverse=True)
    print(f"{name:34s} {len(two) - len(skip):4d}t  2%: ${e2/1e3:7.1f}K dd {100*d2:4.1f}%  3%: ${e3/1e3:7.1f}K dd {100*d3:4.1f}%  tune {k(h['tune'])} check {k(h['check'])}  w/o best 5 {k(sum(kept[5:]))}")

print(f"3-year twin, top 50: {len(two)} trades, {len(shock)} shock ({miss} without an alert in the list; "
      f"{sum(r['pace'] is None for r in shock)} before the pace)\n")
line('1.1.0 twin', set())
for K in (3, 5):
    cut = {r['key'] for r in shock if r['pace'] is not None and r['pace'] < K}
    line(f'shock + >= {K}x the day pace', cut)
    gone = [r for r in shock if r['key'] in cut]
    rets = sorted(float(r['ret']) for r in gone)
    by = defaultdict(list)
    for r in gone: by[(r['date'][:4], half(r['date']))].append(float(r['ret']))
    print(f"   skips {len(gone)}: flat $2K {k(2000 * sum(rets))}, median {pct(st.median(rets)) if rets else '-'}, won {sum(x > 0 for x in rets)}, +100%: {sum(x >= 1 for x in rets)}; "
          + ", ".join(f"{y} {h} {len(v)} {k(2000 * sum(v))}" for (y, h), v in sorted(by.items()))
          + "; best: " + ", ".join(f"{r['sym']} {r['date']} {pct(float(r['ret']))} ({r['pace']:.1f}x)" for r in sorted(gone, key=lambda r: -float(r['ret']))[:4]))
kept_shock = [r for r in shock if r['pace'] is None or r['pace'] >= 5]
for name, g in (('shock trades, all', shock), ('shock >= 5x the pace', kept_shock)):
    for hf in ('tune', 'check'):
        x = [float(r['ret']) for r in g if half(r['date']) == hf]
        print(f"{name:24s} {hf:5s} n={len(x):3d} median {pct(st.median(x))} mean {pct(st.mean(x))} +100%: {sum(y >= 1 for y in x)}")
