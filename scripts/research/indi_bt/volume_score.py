# The volume score (the user, 2026-11-02: "call it volume score. and go"; "each stock affected by the spy in different
# way ... huge drop in spy will affect amzn ... might not affect too much on asts"). For each trade, at its alert:
#   ratio(x)  = x's volume in the alert's window / the median of the same window over x's prior 20 sessions (>= 10)
#               plan: the 3 minutes ending with the alert minute; shock: the 60 seconds ending at the alert second
#               (10-second bars: data/local/bars-10s.sqlite, SPY's missing days in the scratchpad's spy10s.sqlite)
#   volume beta: over the stock's prior 60 sessions, every 3-minute block's log ratio (vs its prior 20 sessions)
#               regressed on SPY's: log r_stock = a + b log r_spy
#   volume score = ratio(stock) / (e^a * ratio(SPY)^b)  = the stock's volume beyond what the market explains for it.
# Usage: volscore.py live <scratchpad>  |  volscore.py twin <scratchpad> <trades.csv> <events_shock.json>
import sys, json, os, sqlite3, math, statistics as st, csv
from datetime import datetime, date as D, timedelta
from zoneinfo import ZoneInfo
NY = ZoneInfo('America/New_York')
MAIN = os.path.expanduser('~/Desktop/Personal/stock-market-assistant/data/local/bars-10s.sqlite')
mode, S = sys.argv[1], sys.argv[2]
dbs = {'main': sqlite3.connect(f'file:{MAIN}?mode=ro', uri=True), 'spy': sqlite3.connect(f'file:{S}/spy10s.sqlite?mode=ro', uri=True)}
def open_ts(d):
    y, m, dd = map(int, d.split('-')); return int(datetime(y, m, dd, 9, 30, tzinfo=NY).timestamp())
def db_for(sym, d):
    if sym != 'SPY': return dbs['main']
    return dbs['main'] if '2025-10-23' <= d <= '2026-10-22' else dbs['spy']
MIN = {}
def minutes(sym, d):
    """The session's 390 minute volumes (None: no bars that day)."""
    k = (sym, d)
    if k not in MIN:
        if len(MIN) > 60000: MIN.clear()
        o = open_ts(d)
        rows = db_for(sym, d).execute('SELECT (start - ?) / 60, SUM(volume) FROM bars WHERE symbol=? AND start>=? AND start<? GROUP BY 1', (o, sym, o, o + 23400)).fetchall()
        if len(rows) < 300: MIN[k] = None
        else:
            v = [0] * 390
            for m, x in rows: v[int(m)] = x
            MIN[k] = v
    return MIN[k]
def secs(sym, d, a, z):
    o = open_ts(d)
    r = db_for(sym, d).execute('SELECT SUM(volume), COUNT(*) FROM bars WHERE symbol=? AND start>=? AND start<?', (sym, o + a, o + z)).fetchone()
    return r[0] or 0
TD = {}
def sessions_before(sym, d, n):
    """The n sessions before d with bars (newest last)."""
    out, x = [], D.fromisoformat(d)
    for i in range(1, 3 * n + 10):
        p = (x - timedelta(days=i)).isoformat()
        if D.fromisoformat(p).weekday() >= 5: continue
        if minutes(sym, p) is not None: out.append(p)
        if len(out) >= n: break
    return out[::-1]
def ratio_window(sym, d, kind, m, sec):
    def vol(day):
        if kind == 'plan':
            v = minutes(sym, day)
            return sum(v[m - 2:m + 1]) if v and m >= 2 else None
        if minutes(sym, day) is None: return None
        return secs(sym, day, sec - 60, sec)
    cur = vol(d)
    hist = [x for x in (vol(p) for p in sessions_before(sym, d, 20)) if x]
    return cur / st.median(hist) if cur and len(hist) >= 10 else None
BETA = {}
def blocks(sym, d):
    v = minutes(sym, d)
    return [sum(v[i:i + 3]) for i in range(0, 390, 3)] if v else None
def beta(sym, d):
    """a, b, sd (the fit's residual spread) of log r_stock = a + b log r_spy over the stock's 60 sessions before d (3-minute blocks)."""
    if (sym, d) in BETA: return BETA[(sym, d)]
    days = sessions_before(sym, d, 80)
    xs, ys = [], []
    for i in range(20, len(days)):
        day = days[i]
        sb, pb = blocks(sym, day), blocks('SPY', day)
        if not sb or not pb: continue
        sh = [blocks(sym, p) for p in days[i - 20:i]]; ph = [blocks('SPY', p) for p in days[i - 20:i]]
        sh = [h for h in sh if h]; ph = [h for h in ph if h]
        if len(sh) < 10 or len(ph) < 10: continue
        for j in range(3, 128):
            ms = st.median(h[j] for h in sh); mp = st.median(h[j] for h in ph)
            if sb[j] > 0 and pb[j] > 0 and ms > 0 and mp > 0:
                xs.append(math.log(pb[j] / mp)); ys.append(math.log(sb[j] / ms))
    if len(xs) < 500: BETA[(sym, d)] = None; return None
    mx, my = st.mean(xs), st.mean(ys)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    a = my - b * mx
    sd = math.sqrt(sum((y - a - b * x) ** 2 for x, y in zip(xs, ys)) / (len(xs) - 2))
    BETA[(sym, d)] = (a, b, sd)
    return BETA[(sym, d)]
def score(sym, d, kind, m, sec):
    rs, rp, ab = ratio_window(sym, d, kind, m, sec), ratio_window('SPY', d, kind, m, sec), beta(sym, d)
    if not rs or not rp or not ab: return {'rs': rs, 'rspy': rp, 'a': ab and ab[0], 'b': ab and ab[1], 'sd': ab and ab[2], 'score': None}
    return {'rs': rs, 'rspy': rp, 'a': ab[0], 'b': ab[1], 'sd': ab[2], 'score': rs / (math.exp(ab[0]) * rp ** ab[1])}
out = {}
if mode == 'live':
    taken = set(json.load(open(f'{S}/volyear/taken_ids.json')))
    sigs = [s for f in sorted(os.listdir(f'{S}/volyear/parts')) if f.startswith('pr_') for s in json.load(open(f'{S}/volyear/parts/' + f))['signals'] if s.get('trade')]
    for i, s in enumerate(sorted(sigs, key=lambda s: (s['symbol'], s['date']))):
        out[s['id']] = score(s['symbol'], s['date'], s['kind'], s['minute'], s['second'])
        if i % 20 == 0: print(i, len(sigs), flush=True)
    json.dump(out, open(f'{S}/volyear/volscore_live.json', 'w'))
else:
    ev = {}
    for e in json.load(open(sys.argv[4])): ev.setdefault((e['sym'], e['date']), []).append(e)
    rows = [r for r in csv.DictReader(open(sys.argv[3])) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] == '2' and r['view'] == 'all']
    for i, r in enumerate(sorted(rows, key=lambda r: (r['sym'], r['date']))):
        k = '|'.join((r['date'], r['sym'], r['minute'], r['side']))
        bm = int(r['minute'])
        if r['alert'] == 'shock':
            al = [e for e in ev.get((r['sym'], r['date']), []) if e['m'] <= bm]
            if not al: out[k] = None; continue
            e = max(al, key=lambda e: e['sec0'])
            out[k] = score(r['sym'], r['date'], 'shock', e['sec0'] // 60, e['sec0'])
        else:
            # the plan alert minute: the last minute <= the buy minute whose 3-minute volume is >= 4x its 20-session median
            v = minutes(r['sym'], r['date']); hist = [minutes(r['sym'], p) for p in sessions_before(r['sym'], r['date'], 20)]
            hist = [h for h in hist if h]
            am = None
            for m in range(bm, 2, -1):
                if v and len(hist) >= 10 and sum(v[m - 2:m + 1]) >= 4 * st.median(sum(h[m - 2:m + 1]) for h in hist):
                    am = m; break
            out[k] = score(r['sym'], r['date'], 'plan', am, None) if am is not None else None
            if out[k] is not None: out[k]['alert_minute'] = am
        if i % 20 == 0: print(i, len(rows), flush=True)
    json.dump(out, open(f'{S}/volyear/volscore_twin.json', 'w'))
v = [x['score'] for x in out.values() if x and x.get('score')]
print(len(out), 'trades,', len(v), 'scored; median', round(st.median(v), 2), '; beta median', round(st.median(x['b'] for x in out.values() if x and x.get('b') is not None), 2))
