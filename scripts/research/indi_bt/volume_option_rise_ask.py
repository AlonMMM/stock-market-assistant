# The user, 2026-11-02: "give me data on the option price - the size of it before the alert/bought 1-5-10-15 minutes by
# destribution". Volume 1.1.0 live-code year (pr_ parts), the 145 trades the live account takes; the bought contract's
# mid (Databento book, row m = the book as minute m began) at the buy minute and 1 / 5 / 10 / 15 minutes before.
import json, os, sqlite3, gzip, base64, statistics as st
from datetime import date as D
db = sqlite3.connect('volyear/d1.sqlite')
taken = None
rows = []
for f in sorted(os.listdir('volyear/parts')):
    if not f.startswith('pr_'): continue
    for s in json.load(open('volyear/parts/' + f))['signals']:
        t = s.get('trade')
        if not t: continue
        q = db.execute("select quotes from option_quotes where contract=? and date=? order by source limit 1", (t['contract'], s['date'])).fetchone()
        q = json.loads(gzip.decompress(base64.b64decode(q[0][3:]))) if q else []
        def mid(m):
            best = None
            for r in q:
                if r[0] > m: break
                best = r
            return best[2] if best and m - best[0] < 5 and best[2] > 0 else None
        m = t['buyMinute']
        ret = (t['sell'] * 100 - 0.62) / (t['buy'] * 100 + 0.62) - 1
        rows.append({'id': s['id'], 'kind': s['kind'], 'date': s['date'], 'ret': ret, 'buy': t['buy'], 'm0': mid(m), **{f'm{k}': mid(m - k) for k in (1, 5, 10, 15)}})
json.dump({r['id']: {k: (r['buy'] / r[f'm{k}'] - 1 if r[f'm{k}'] else None) for k in (1, 5, 10, 15)} for r in rows}, open('volyear/optrise_ask.json', 'w'))
print(len(rows))
