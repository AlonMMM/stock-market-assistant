# The user, 2026-11-02: "do we normelized the volume in both signals to the spy volume? ... if in the single minutes the
# spy volume is huge we should not consider out signal" -> "start with A". For every traded pr_ signal (Volume 1.1.0
# live-code year): the 3-minute window's volume vs the median of the same window over the prior 20 sessions, for the
# stock and for SPY. Plan: the window ending at the alert minute (as alertRule); shock: the window ending at the last
# closed minute before the alert second. Writes volyear/spynorm.json {id: {rs, rspy}}.
import json, os, sqlite3, gzip, base64, statistics as st
from datetime import datetime
from zoneinfo import ZoneInfo
from collections import defaultdict
NY = ZoneInfo('America/New_York')
db = sqlite3.connect('volyear/d1.sqlite')
def sess(bars, date):
    y, m, d = map(int, date.split('-')); o = int(datetime(y, m, d, 9, 30, tzinfo=NY).timestamp())
    return {(b[0] - o) // 60: b[5] for b in bars if o <= b[0] < o + 390 * 60}
spy = defaultdict(list)
for b in json.load(open('volyear/spy_min_year.json')):
    spy[datetime.fromtimestamp(b[0], NY).strftime('%Y-%m-%d')].append(b)
spy = {d: sess(v, d) for d, v in spy.items()}
spy_days = sorted(d for d, v in spy.items() if len(v) > 300)
def win(day, m): return sum(day.get(k, 0) for k in (m - 2, m - 1, m)) if all(k in day for k in (m - 2, m - 1, m)) else None
def ratio(days_vol, prior, m):
    cur = win(days_vol, m)
    hist = [x for x in (win(p, m) for p in prior[-20:]) if x]
    return cur / st.median(hist) if cur and len(hist) >= 10 else None
cache = {}
def stock_days(sym):
    if sym not in cache:
        cache.clear()
        rows = db.execute("select date, bars from minute_bars where key=? order by date", (sym + ':sip:1Min:raw',)).fetchall()
        cache[sym] = {d: sess(json.loads(gzip.decompress(base64.b64decode(b[3:]))), d) for d, b in rows}
    return cache[sym]
out, miss = {}, 0
sigs = [s for f in sorted(os.listdir('volyear/parts')) if f.startswith('pr_') for s in json.load(open('volyear/parts/' + f))['signals'] if s.get('trade')]
for s in sorted(sigs, key=lambda s: s['symbol']):
    m = s['minute'] if s['kind'] == 'plan' else s['second'] // 60 - 1
    sd = stock_days(s['symbol']); days = sorted(d for d in sd if len(sd[d]) > 300)
    prior = [sd[d] for d in days if d < s['date']]
    sprior = [spy[d] for d in spy_days if d < s['date']]
    rs = ratio(sd.get(s['date'], {}), prior, m) if s['date'] in sd else None
    rspy = ratio(spy.get(s['date'], {}), sprior, m)
    if rs is None or rspy is None: miss += 1
    out[s['id']] = {'rs': rs, 'rspy': rspy}
json.dump(out, open('volyear/spynorm.json', 'w'))
v = [x['rspy'] for x in out.values() if x['rspy']]
print(len(out), 'signals,', miss, 'missing a ratio; SPY ratio at the alerts: median', round(st.median(v), 2), 'p75', round(sorted(v)[3 * len(v) // 4], 2), 'p90', round(sorted(v)[9 * len(v) // 10], 2), '>=2:', sum(x >= 2 for x in v), '>=3:', sum(x >= 3 for x in v))
for k in ('plan', 'shock'):
    r = [out[s['id']]['rs'] / out[s['id']]['rspy'] for s in sigs if s['kind'] == k and out[s['id']]['rs'] and out[s['id']]['rspy']]
    print(k, 'stock / SPY ratio: median', round(st.median(r), 1), '< 4:', sum(x < 4 for x in r), 'of', len(r))
