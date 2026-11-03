"""Group A: Volume bot entries near support / resistance (2026-11-03, unattended, look 1 for every idea).

The user's analyst review (single trades):
  - NBIS put 2025-11-13 on the day low after a gap down, bounced at once: "classic - bounce from the support. maybe we
    should make it more difficult to trade if we are close to the support (wait more time?)"
  - MSFT call right under the day's high, never broke it; SLV 49C 28 Oct poked the 15-min high and fell back: "in volume
    alert (not shock) when we're closing to the resistance/support need to prove breakout"
  - CRM put 2026-10-08 just after breaking yesterday's / 5-day low, back above in ~15 min: "broke support alert, on the
    volume alert (not shock) maybe consider waiting for confirmation"
  - QCOM 180 put 2025-10-27 after a $172 -> $205 surge: "just a pullback after huge run, we should not put in this case
    (or call in the other way around)"

Built on Volume 1.2.0 (live since 2026-11-03, stage 5 pending): the live-code year (v12_ parts of the 1.2.0 release,
51 stocks, 2025-11-03 .. 2026-10-30, real books, no broker stop, the live limits). All levels set before the run.

Levels (the app's trade chart / packages/trading/src/bot/levels.ts): yesterday's and the 5 sessions' high / low
(regular hours), the first 15 minutes' high / low (once minute 15 has passed), the day's high / low so far (minutes
before the alert minute). For a call the highs, for a put the lows. Distance x = how far the price at the buy (the
trade's stockIn) is PAST the level in the trade's direction, in S30 (the alert's unit; negative = still under it).
"Near" (set from the user's examples before the run): UNDER = a level still ahead within 0.5 S30 (-0.5 <= x < 0;
MSFT under the day's high, SLV at the 15-min high), any of the four levels; JUST BROKE = a prior level (15-min,
yesterday's, 5-day; not the day so far, which every burst to a new high breaks) passed by at most 1.1 S30 (0 <= x <=
1.1 = the plan's minimum burst; CRM 2026-10-08 was 1.03 past yesterday's low: the plan alert's burst is >= 1.1 S30, so a level the burst broke
sits up to ~1.1 S30 behind). NEAR = UNDER or JUST BROKE.

Versions (plan alerts only unless named; the user: "volume alert (not shock)"):
  A1 skip UNDER    A2 skip JUST BROKE    A3 skip NEAR (the thesis)    A4 = A3 on plan + shock    A5 = A3 at half bands
  (under 0.25, past 0.55)
  B1 NEAR -> buy at the first minute close >= 0.25 S30 past the farthest near level, within 5 minutes, else none
  B2 NEAR -> wait 5 minutes; buy only if that close is still >= 0.25 S30 past the level
  B3 = B2 with 10 minutes    B4 = B1 on plan + shock
  C1 no plan alert against the move since the open >= 2 S30 (1.2.0's shock rule extended to the plan)
  C2 same >= 3 S30           C3 against the last 60 minutes >= 2 S30
A delayed buy: the same contract, decided on a minute close, priced as the engine's minute fallback (the book as that
minute closed: mid + a quarter of the spread; the next minute's ask when its bid is already above), the shock's 30%
spread cap, the engine's walkExit (no stop 30 min, give-back 0.75 S30 on minute closes, the end minute), the sale at the
book's bid. Real Databento minute books (D1 option_quotes); a gap is listed, never dropped.

Run: python3 -I levels_year.py <testA dir> <D1 snapshot sqlite>   (writes mods.json, feats.json)
"""
import sqlite3, base64, gzip, json, sys, os, statistics as st
from datetime import datetime, date as D
from zoneinfo import ZoneInfo
from collections import defaultdict

T, DB = sys.argv[1], sys.argv[2]
NY = ZoneInfo('America/New_York')
db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
dec = lambda s: json.loads(gzip.decompress(base64.b64decode(s[3:])) if s.startswith('gz:') else s)

parts = [json.load(open(os.path.join(T, 'in/parts', f))) for f in sorted(os.listdir(os.path.join(T, 'in/parts'))) if f.startswith('v12_')]
sigs = [s for p in parts for s in p['signals']]
traded = [s for s in sigs if s.get('trade')]
opens = json.load(open(os.path.join(T, 'in/opens.json')))
print(f'1.2.0 year: {len(sigs)} alerts, {len(traded)} with a trade ({sum(s["kind"] == "plan" for s in traded)} plan, {sum(s["kind"] == "shock" for s in traded)} shock)')

# --- stock minute bars (regular session, minute 0 = 09:30 NY) ---
dates_of = defaultdict(list)
for k, d in db.execute('select key, date from minute_bars'): dates_of[k.split(':')[0]].append(d)
for k in dates_of: dates_of[k].sort()
_bars = {}
def bars(sym, d):
    if (sym, d) not in _bars:
        r = db.execute('select bars from minute_bars where key=? and date=?', (f'{sym}:sip:1Min:raw', d)).fetchone()
        out = {}
        if r:
            o = datetime.fromisoformat(d + 'T09:30').replace(tzinfo=NY).timestamp()
            for ts, op, hi, lo, cl, v in dec(r[0]):
                m = int((ts - o) // 60)
                if 0 <= m < 390: out[m] = (op, hi, lo, cl, v)
        _bars[(sym, d)] = out
    return _bars[(sym, d)]

def prior_sessions(sym, d, n=5):
    ds = [x for x in dates_of[sym] if x < d and bars(sym, x)]
    return ds[-n:] if len(ds) >= n else None

gaps = defaultdict(list)
def levels(s):
    """[(name, price)] of the trade's side (highs for a call, lows for a put), known before the alert minute."""
    sym, d, m = s['symbol'], s['date'], s['minute']
    call = s['trade']['right'] == 'C'
    b = bars(sym, d)
    out = []
    if not b: gaps['no day bars'].append(s['id'])
    prev = [x for x in b if x < m]
    if prev: out.append(('day', max(b[x][1] for x in prev) if call else min(b[x][2] for x in prev)))
    if m >= 15 and any(x < 15 for x in b):
        o15 = [x for x in b if x < 15]
        out.append(('15min', max(b[x][1] for x in o15) if call else min(b[x][2] for x in o15)))
    ps = prior_sessions(sym, d)
    if ps:
        y = bars(sym, ps[-1])
        out.append(('yday', max(v[1] for v in y.values()) if call else min(v[2] for v in y.values())))
        allv = [v for x in ps for v in bars(sym, x).values()]
        out.append(('5day', max(v[1] for v in allv) if call else min(v[2] for v in allv)))
    else: gaps['no 5 prior sessions'].append(s['id'])
    return out

def past(p, L, call, u): return ((p / L - 1) if call else (1 - p / L)) / u

# --- option books / bars of the traded contracts ---
def quotes(c, d):
    r = db.execute("select quotes from option_quotes where contract=? and date=? order by source='databento' desc", (c, d)).fetchone()
    return dec(r[0]) if r else None
def obars(c, d):
    r = db.execute('select bars from option_bars where contract=? and date=?', (c, d)).fetchone()
    return dec(r[0]) if r else []
def book_at(q, minute):
    best = None
    for row in q:
        if row[0] > minute: break
        best = row
    return best if best and minute - best[0] < 5 else None

def walk_exit(sym, d, ob, ct, call, stock_in, u):
    b = bars(sym, d)
    length = max(b) + 1 if b else 390
    length = 210 if length <= 211 else 390
    end = min(360, length - 30)
    b0 = next((x[0] for x in ob if ct <= x[0] <= ct + 3), ct)
    best = stock_in
    for t in range(b0 + 1, end + 1):
        spot = b[t][3] if t in b else None
        if spot: best = max(best, spot) if call else min(best, spot)
        if t - b0 <= 30 and t < end: continue
        if t >= end: return t, 'end'
        if spot and abs(spot / best - 1) >= 0.75 * u: return t, 'giveback'
    return end, 'end'

def delayed(s, m):
    """The same contract bought on the close of minute m (engine minute pricing), exit walked; None = gap."""
    t = s['trade']; c = t['contract']; call = t['right'] == 'C'
    q = quotes(c, s['date'])
    if not q: return 'gap: no minute books'
    a, later = book_at(q, m), book_at(q, m + 1)
    if not a or a[1] <= 0 or a[2] <= 0: return 'gap: no book at the delayed buy'
    mid = (a[1] + a[2]) / 2
    buy = mid + (a[2] - mid) / 2
    if later and later[1] > 0 and later[1] > buy: buy = later[2]
    if s['kind'] == 'shock' and (a[2] - a[1]) / mid > 0.3: return 'spread'
    b = bars(s['symbol'], s['date'])
    if m not in b: return 'gap: no stock bar at the decision'
    ct = m + 1
    em, why = walk_exit(s['symbol'], s['date'], obars(c, s['date']), ct, call, b[m][3], s['unit'])
    sale = book_at(q, em)
    if not sale: return 'gap: no book at the sale'
    return {'buyMinute': ct, 'buy': buy, 'exitMinute': em, 'exitReason': why, 'sell': sale[1], 'stockIn': b[m][3], 'buyPriced': 'minutes'}

# --- validation: the engine's exit walked again on the original trades ---
ok = n = 0; bad = []
for s in traded:
    t = s['trade']; q = quotes(t['contract'], s['date'])
    em, _ = walk_exit(s['symbol'], s['date'], obars(t['contract'], s['date']), t['buyMinute'], t['right'] == 'C', t['stockIn'], s['unit'])
    sale = book_at(q, em) if q else None
    n += 1
    if em == t['exitMinute'] and sale and abs(sale[1] - t['sell']) < 1e-9: ok += 1
    else: bad.append(f"{s['id']} exit {t['exitMinute']}->{em} sell {t['sell']}->{sale[1] if sale else None}")
print(f'exit re-walk check on the original trades: {ok}/{n} identical (exit minute and sale)'); print('  ' + '\n  '.join(bad[:8]))

# --- features ---
F = {}
for s in traded:
    t = s['trade']; call = t['right'] == 'C'; u = s['unit']; p = t['stockIn']
    lv = levels(s)
    xs = {nm: past(p, L, call, u) for nm, L in lv}
    o = opens.get(s['symbol'] + '|' + s['date'])
    if not o and 0 in bars(s['symbol'], s['date']):
        gaps['open price from the minute bars (not in opens.json)'].append(s['id']); o = bars(s['symbol'], s['date'])[0][0]
    mv_open = (s['price'] / o - 1) / u if o and u else None
    b = bars(s['symbol'], s['date']); am = s['minute']
    h1 = b.get(am - 61, (None, None, None, None))[3] if am - 61 in b else (b[0][0] if 0 in b else None)
    mv_hour = (s['price'] / h1 - 1) / u if h1 and u else None
    if mv_open is None: gaps['no open price at all'].append(s['id'])
    F[s['id']] = {'kind': s['kind'], 'side': t['right'], 'date': s['date'], 'sym': s['symbol'], 'x': xs, 'lv': dict(lv),
                  'up': s['alert'] == 'up', 'mv_open': mv_open, 'mv_hour': mv_hour}

def near(f, du=0.5, dp=1.1, under=('day', '15min', 'yday', '5day'), broke=('15min', 'yday', '5day')):
    return [nm for nm, x in f['x'].items() if (nm in under and -du <= x < 0) or (nm in broke and 0 <= x <= dp)]
def against(f, ref, X):
    mv = f['mv_open'] if ref == 'open' else f['mv_hour']
    return mv is not None and abs(mv) >= X and (mv > 0) != f['up']

def confirm(s, f, names, mode, N):
    """B: the minute close that confirms the break of the highest near level (call) / lowest (put), or None."""
    t = s['trade']; call = t['right'] == 'C'; u = s['unit']
    L = (max if call else min)(f['lv'][nm] for nm in names)
    b = bars(s['symbol'], s['date']); B = t['buyMinute']
    if mode == 'first':
        for m in range(B, B + N + 1):
            if m in b and past(b[m][3], L, call, u) >= 0.25: return m
        return None
    m = B + N
    return m if m in b and past(b[m][3], L, call, u) >= 0.25 else None

V = [('1.2.0 (base)', {}), ]
mods = [{'name': '1.2.0 (base)', 'base': 'v12'}, {'name': '1.1.0 (reference)', 'base': 'pr'}]
info = {}
def add(name, idea, rule):
    skip, rep, touched, notes = [], {}, [], defaultdict(int)
    for s in traded:
        f = F[s['id']]
        r = rule(s, f)
        if r is None: continue
        touched.append(s['id'])
        if r == 'skip': skip.append(s['id']); continue
        if isinstance(r, str): notes[r] += 1; rep[s['id']] = None; continue
        rep[s['id']] = r
    mods.append({'name': name, 'base': 'v12', 'skip': skip, 'replace': rep})
    info[name] = {'idea': idea, 'touched': touched, 'notes': dict(notes)}

ALL = ('day', '15min', 'yday', '5day'); PRIOR = ('15min', 'yday', '5day')
def skipnear(kinds, **kw):
    return lambda s, f: 'skip' if f['kind'] in kinds and near(f, **kw) else None
def waitnear(mode, N, kinds):
    def r(s, f):
        if f['kind'] not in kinds: return None
        nm = near(f)
        if not nm: return None
        m = confirm(s, f, nm, mode, N)
        if m is None: return 'no confirmation'
        d = delayed(s, m)
        if isinstance(d, str): return d if d.startswith('gap') or d == 'spread' else d
        return d
    return r
add('A1 skip under a level (0.5)', 'A', skipnear(('plan',), broke=()))
add('A2 skip just broke a prior level (1.1)', 'A', skipnear(('plan',), under=()))
add('A3 skip near (under or just broke)', 'A', skipnear(('plan',)))
add('A4 = A3 on plan + shock', 'A', skipnear(('plan', 'shock')))
add('A5 = A3 at half bands (0.25 / 0.55)', 'A', skipnear(('plan',), du=0.25, dp=0.55))
add('B1 near: first close 0.25 past, 5 min', 'B', waitnear('first', 5, ('plan',)))
add('B2 near: wait 5 min, still 0.25 past', 'B', waitnear('wait', 5, ('plan',)))
add('B3 near: wait 10 min, still 0.25 past', 'B', waitnear('wait', 10, ('plan',)))
add('B4 = B1 on plan + shock', 'B', waitnear('first', 5, ('plan', 'shock')))
add('C1 no plan against the open >= 2', 'C', lambda s, f: 'skip' if f['kind'] == 'plan' and against(f, 'open', 2) else None)
add('C2 no plan against the open >= 3', 'C', lambda s, f: 'skip' if f['kind'] == 'plan' and against(f, 'open', 3) else None)
add('C3 no plan against the last hour >= 2', 'C', lambda s, f: 'skip' if f['kind'] == 'plan' and against(f, 'hour', 2) else None)
# control for B: every near plan trade re-priced at its own buy minute's close with the same minute method (no wait)
def ctrl(s, f):
    if f['kind'] != 'plan' or not near(f): return None
    d = delayed(s, s['trade']['buyMinute'] - 1)
    return d
add('B0 control: near plan trades re-priced by minutes, no wait', 'ctrl', ctrl)

json.dump(mods, open(os.path.join(T, 'mods.json'), 'w'))
json.dump({'F': F, 'info': info, 'gaps': {k: v for k, v in gaps.items()}}, open(os.path.join(T, 'feats.json'), 'w'))
print('missing data:', {k: len(v) for k, v in gaps.items()})
for k, v in info.items(): print(f"  {k:44s} touches {len(v['touched']):3d} traded alerts {v['notes'] or ''}")
# the thesis examples in the year
for sid, f in F.items():
    if (f['sym'], f['date']) in (('NBIS', '2025-11-13'), ('CRM', '2026-10-08'), ('MSFT', '2026-01-28'), ('MSFT', '2026-01-29')) or f['sym'] == 'MSFT' and False:
        print('  example', sid, f['side'], {k: round(v, 2) for k, v in f['x'].items()}, 'open', f['mv_open'] and round(f['mv_open'], 1))
