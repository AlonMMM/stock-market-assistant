# The user, 2026-11-02: "Can you test a rolling strategy? Say we are on 400%, sell all and buy 0.3 delta at 50% from the
# money. Check this on last 6 month first." Read: the first minute book whose bid is >= 5x the buy (+400%) sells all;
# 50% of the proceeds buys the 0.30-delta strike of the same side and expiry (the book that minute, mid + half the
# spread), the other 50% stays cash; the new leg sells on the trade's own exit (the give-back is on the stock, so the
# exit minute does not change) at that minute's bid. Variants: hold (1.1.0), take all at +400% (no rebuy), roll 50%,
# roll 100%. Writes volyear/roll.json: {variant: {signal id: effective sell price}} for the account (rollacct.ts).
import json, os, sqlite3, gzip, base64, math
from datetime import datetime
from zoneinfo import ZoneInfo
db = sqlite3.connect('volyear/d1.sqlite')
NY = ZoneInfo('America/New_York')
def unz(x): return json.loads(gzip.decompress(base64.b64decode(x[3:])))
def books(contract, date):
    r = db.execute("select quotes from option_quotes where contract=? and date=? order by source='databento' desc", (contract, date)).fetchone()
    return {m: (b, a) for m, b, a in unz(r[0])} if r else {}
def stock(sym, date):
    r = db.execute("select bars from minute_bars where key=? and date=?", (sym + ':sip:1Min:raw', date)).fetchone()
    y, mo, d = map(int, date.split('-'))
    o = int(datetime(y, mo, d, 9, 30, tzinfo=NY).timestamp())
    return {(b[0] - o) // 60: b[4] for b in unz(r[0])} if r else {}
def book_at(bk, m):   # the app's bookAt: the latest row at or before m
    ks = [k for k in bk if k <= m]
    return bk[max(ks)] if ks else None
N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
def bs(S, K, T, v, call):
    d1 = (math.log(S / K) + (0.04 + v * v / 2) * T) / (v * math.sqrt(T)); d2 = d1 - v * math.sqrt(T)
    return (S * N(d1) - K * math.exp(-0.04 * T) * N(d2)) if call else (K * math.exp(-0.04 * T) * N(-d2) - S * N(-d1)), (N(d1) if call else N(d1) - 1)
def delta_of(price, S, K, T, call):
    lo, hi = 0.01, 5.0
    for _ in range(60):
        v = (lo + hi) / 2
        if bs(S, K, T, v, call)[0] > price: hi = v
        else: lo = v
    return abs(bs(S, K, T, (lo + hi) / 2, call)[1])
acct = json.load(open('volyear/pr236.json'))
taken = {t['signal']['id'] for t in acct['trades'] if t['status'] == 'taken'}
out = {'take': {}, 'roll50': {}, 'roll100': {}}
for f in sorted(os.listdir('volyear/parts')):
    if not f.startswith('pr_'): continue
    for s in json.load(open('volyear/parts/' + f))['signals']:
        t = s.get('trade')
        if not t or s['id'] not in taken: continue
        bk = books(t['contract'], s['date'])
        r = next((m for m in range(t['buyMinute'] + 1, t['exitMinute']) if m in bk and bk[m][0] >= 5 * t['buy']), None)
        if r is None: continue
        sold = bk[r][0]
        out['take'][s['id']] = sold
        px = stock(s['symbol'], s['date'])
        S = px.get(r) or px.get(r - 1)
        exp = datetime.fromisoformat(t['expiry'] + 'T16:00').replace(tzinfo=NY)
        now = datetime.fromisoformat(s['date'] + 'T09:30').replace(tzinfo=NY).timestamp() + 60 * (r + 1)
        T = max((exp.timestamp() - now) / (365 * 86400), 1 / (365 * 24 * 60))
        call = t['right'] == 'C'
        root = t['contract'][:-9]
        cands = []
        for (c,) in db.execute("select contract from option_quotes where contract like ? and date=?", (root + '%', s['date'])):
            q = book_at(books(c, s['date']), r)
            if not q or q[0] <= 0 or q[1] <= 0: continue
            K = int(c[-8:]) / 1000
            mid = (q[0] + q[1]) / 2
            if mid <= max((S - K) if call else (K - S), 0) + 0.005: continue   # no time value: no implied vol
            cands.append((abs(delta_of(mid, S, K, T, call) - 0.30), c, K, q))
        if not cands:
            print(f"{s['symbol']} {s['date']}: +400% at {r}, no 0.30 strike with a book -> take only"); continue
        _, c, K, q = min(cands)
        buy2 = (q[0] + q[1]) / 2 + (q[1] - q[0]) / 4
        sell2 = (book_at(books(c, s['date']), t['exitMinute']) or (0, 0))[0]
        d = delta_of((q[0] + q[1]) / 2, S, K, T, call)
        m0 = sold / t['buy']
        for v, share in (('roll50', 0.5), ('roll100', 1.0)):
            out[v][s['id']] = t['buy'] * m0 * ((1 - share) + share * sell2 / buy2)
        hhmm = lambda m: f"{9 + (30 + m) // 60}:{(30 + m) % 60:02d}"
        print(f"{s['symbol']:5s} {s['date']} {s['kind']:5s} {t['contract'][-9:]} buy {t['buy']:.2f} | +400% at {hhmm(r)} bid {sold:.2f} ({100*(m0-1):+.0f}%) | "
              f"held to {hhmm(t['exitMinute'])}: {t['sell']:.2f} ({100*(t['sell']/t['buy']-1):+.0f}%) | roll into {c[-9:]} d {d:.2f} at {buy2:.2f} -> {sell2:.2f} ({100*(sell2/buy2-1):+.0f}%) | "
              f"roll 50%: {100*(out['roll50'][s['id']]/t['buy']-1):+.0f}%, roll 100%: {100*(out['roll100'][s['id']]/t['buy']-1):+.0f}%")
json.dump(out, open('volyear/roll.json', 'w'))
