# testB (2026-11-03), group B "buying the spike itself": the features of each traded alert at its buy second t
# (= the side second + 2), for the filters B (a huge alert minute) and C (an SPY-driven move). Read-only data:
#   stock / SPY 10-second bars: data/local/bars-10s.sqlite (SPY's days outside 2025-10-23..2026-10-22: spy10s.sqlite)
#   r_stock, r_spy   = the 60-second return ending at t (last 10-s close at or before t vs at or before t - 60),
#                      signed the trade's way (call +, put -)
#   usual            = the median |60-s return| of the stock over its prior 5 sessions (non-overlapping 60-s blocks)
#   beta             = OLS slope of the stock's 60-s returns on SPY's over the prior 10 sessions
#   opt_rise         = the price paid / the option's mid a minute earlier: the Databento minute book row buyMinute - 1
#                      (row m = the book as minute m began, as volume_option_before_buy.py), from the testB D1 copy
# Usage: python3 tb_spike_features.py <parts dir> <prefix> <out.json>
import sys, os, json, glob, sqlite3, statistics as st, gzip, base64
from datetime import datetime
from zoneinfo import ZoneInfo
NY = ZoneInfo('America/New_York')
MAIN = os.path.expanduser('~/Desktop/Personal/stock-market-assistant/data/local/bars-10s.sqlite')
SPY2 = '/private/tmp/claude-501/-Users-alonmo-Desktop-Personal-stock-market-assistant/6fb99457-9696-4e71-87a7-c3ad635440fb/scratchpad/spy10s.sqlite'
dbm = sqlite3.connect(f'file:{MAIN}?mode=ro', uri=True)
dbs = sqlite3.connect(f'file:{SPY2}?mode=ro', uri=True)
def db_for(sym, d):
    return dbm if sym != 'SPY' or '2025-10-23' <= d <= '2026-10-22' else dbs
def open_ts(d):
    y, m, dd = map(int, d.split('-')); return int(datetime(y, m, dd, 9, 30, tzinfo=NY).timestamp())
DAYS = sorted(r[0] for r in dbm.execute("select date from symbol_days where symbol='QQQ'"))
CL = {}
def closes(sym, d):
    """[(end second from the open, close)] of the session's 10-s bars."""
    k = (sym, d)
    if k not in CL:
        o = open_ts(d)
        CL[k] = [(s - o + 10, c) for s, c in db_for(sym, d).execute(
            'select start, close from bars where symbol=? and start>=? and start<?', (sym, o, o + 23400)).fetchall()]
    return CL[k]
def price_at(rows, t):
    best = None
    for e, c in rows:
        if e <= t: best = c
        else: break
    return best
def blocks(sym, d):
    rows = closes(sym, d)
    out, j, last = {}, 0, None
    for b in range(1, 391):
        while j < len(rows) and rows[j][0] <= b * 60: last = rows[j][1]; j += 1
        out[b] = last
    return out
PRIOR = {}
def prior_stats(sym, d):
    k = (sym, d)
    if k in PRIOR: return PRIOR[k]
    i = DAYS.index(d) if d in DAYS else None
    if i is None or i < 10: PRIOR[k] = (None, None); return PRIOR[k]
    absr, xs, ys = [], [], []
    for p in DAYS[i - 10:i]:
        sb, pb = blocks(sym, p), blocks('SPY', p)
        for b in range(2, 391):
            a0, a1, s0, s1 = sb.get(b - 1), sb.get(b), pb.get(b - 1), pb.get(b)
            if not (a0 and a1): continue
            r = a1 / a0 - 1
            if p in DAYS[i - 5:i]: absr.append(abs(r))
            if s0 and s1: xs.append(s1 / s0 - 1); ys.append(r)
    usual = st.median(absr) if len(absr) > 100 else None
    beta = None
    if len(xs) > 200:
        mx, my = st.fmean(xs), st.fmean(ys)
        vx = sum((x - mx) ** 2 for x in xs)
        beta = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / vx if vx > 0 else None
    PRIOR[k] = (usual, beta)
    return PRIOR[k]
pdir, prefix, out = sys.argv[1:4]
D1 = sqlite3.connect(f'file:{os.path.dirname(os.path.dirname(pdir))}/d1.sqlite?mode=ro', uri=True)
def mid_before(contract, d, m):
    q = D1.execute("select quotes from option_quotes where contract=? and date=? order by source limit 1", (contract, d)).fetchone()
    q = json.loads(gzip.decompress(base64.b64decode(q[0][3:]))) if q else []
    best = None
    for r in q:
        if r[0] > m: break
        best = r
    return (best[1] + best[2]) / 2 if best and m - best[0] < 5 and best[2] > 0 and best[1] >= 0 else None
feat, miss = {}, {'opt_prev': [], 'stock10s': [], 'spy10s': [], 'prior': []}
for f in sorted(glob.glob(f'{pdir}/{prefix}_*.json')):
    for s in json.load(open(f))['signals']:
        tr = s.get('trade')
        if not tr: continue
        t = tr['sideSecond'] + 2
        sign = 1 if tr['right'] == 'C' else -1
        x = {'kind': s['kind'], 'date': s['date'], 'symbol': s['symbol']}
        pm = mid_before(tr['contract'], s['date'], tr['buyMinute'] - 1)
        x['opt_rise'] = tr['buy'] / pm if pm else None
        if not pm: miss['opt_prev'].append(s['id'])
        sr, pr = closes(s['symbol'], s['date']), closes('SPY', s['date'])
        a1, a0 = price_at(sr, t), price_at(sr, t - 60)
        b1, b0 = price_at(pr, t), price_at(pr, t - 60)
        x['r_stock'] = sign * (a1 / a0 - 1) if a1 and a0 else None
        x['r_spy'] = sign * (b1 / b0 - 1) if b1 and b0 else None
        if x['r_stock'] is None: miss['stock10s'].append(s['id'])
        if x['r_spy'] is None: miss['spy10s'].append(s['id'])
        usual, beta = prior_stats(s['symbol'], s['date'])
        if usual is None or beta is None: miss['prior'].append(s['id'])
        x['usual'], x['beta'] = usual, beta
        x['move_x'] = abs(x['r_stock']) / usual if x['r_stock'] is not None and usual else None
        x['spy_share'] = (beta * x['r_spy'] / x['r_stock']) if (beta is not None and x['r_spy'] is not None and x['r_stock'] and x['r_stock'] > 0) else None
        feat[s['id']] = x
json.dump({'features': feat, 'missing': miss}, open(out, 'w'))
print(len(feat), 'trades;', {k: len(v) for k, v in miss.items()})
