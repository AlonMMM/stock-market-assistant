# Features at the buy minute (closed minutes only) for every traded pr_ signal: last-10-min volume vs the day's minute
# average so far, position in the day's range our way. Writes volyear/dblfeat.json {id: {vol10, pos}}.
import json, os, sqlite3, gzip, base64
from datetime import datetime
from zoneinfo import ZoneInfo
NY = ZoneInfo('America/New_York')
db = sqlite3.connect('volyear/d1.sqlite')
out, miss = {}, 0
for f in sorted(os.listdir('volyear/parts')):
    if not f.startswith('pr_'): continue
    cache = {}
    for s in json.load(open('volyear/parts/' + f))['signals']:
        t = s.get('trade')
        if not t: continue
        k = (s['symbol'], s['date'])
        if k not in cache:
            row = db.execute("select bars from minute_bars where key=? and date=?", (s['symbol'] + ':sip:1Min:raw', s['date'])).fetchone()
            cache[k] = json.loads(gzip.decompress(base64.b64decode(row[0][3:]))) if row else None
        bars = cache[k]
        y, mo, d = map(int, s['date'].split('-'))
        o = int(datetime(y, mo, d, 9, 30, tzinfo=NY).timestamp())
        sess = [b for b in (bars or []) if o <= b[0] < o + 60 * t['buyMinute']]
        if not sess: miss += 1; continue
        vols = [b[5] for b in sess]
        hi = max(b[2] for b in sess); lo = min(b[3] for b in sess); c = sess[-1][4]
        pos = (c - lo) / (hi - lo) if hi > lo else .5
        out[s['id']] = {'vol10': (sum(vols[-10:]) / len(vols[-10:])) / (sum(vols) / len(vols)), 'pos': pos if t['right'] == 'C' else 1 - pos}
json.dump(out, open('volyear/dblfeat.json', 'w'))
print(len(out), 'traded signals,', miss, 'missing')
