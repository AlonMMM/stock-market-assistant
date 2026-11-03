"""Volume bot exits, group C (2026-11-03, unattended test for the lead; auto mode).

The user's analyst review of single trades (in their words):
  Task 3:  "its about 30 minutes grace, maybe we can found better way"  (a call sold at 0.11 on the -80% stop exactly as
           the 30-minute grace ended, the stock back near the entry; the option line had no points during the hold)
  Task 11: "if the shock enter and it's a single bar and than volume fade - consider decrease the window time frame"
  Task 6:  "try (once again) smart exit in 0dte"  (GOOGL 367.5 put 0DTE 2026-08-05: 1.10 -> ~10.5 -> sold ~4.85)
  Task 2:  "for alerts of ticker with the same direction of already open position - if we have a big gain we can use it
           as a trigger to rolling"

Built on Volume 1.2.0 (live since 2026-11-03, candidate; stage 5 pending) = the app engine's own parts `v12_*`
(origin/main backtest.ts, 51 stocks, 2025-11-03 .. 2026-10-30, real books, saved settings, live limits), with the
broker's -80% safety stop modelled as the engine does (first minute book after the buy with bid <= 20% of the buy sells
at that bid). Every exit is re-walked here on the same data (year/d1.sqlite: stock minute bars, option minute books
and bars); the plain re-walk reproduces every engine trade (exit minute and sale) before any variant is read.

Variants (levels set before the run):
  A grace end / the -80% stop:
    A1 stop only on a real two-sided book (bid > 0, ask > 0, spread <= 50% of the mid)
    A2 A1 + the stop only while the stock is against the entry (call: close < stock at the side; put: >)
    A3 the grace waits up to 15 more minutes (45 max) while the stock is not 0.25 S30 against the entry
    A4 the same, up to 30 more minutes (60 max)
  B single-bar shock that fades (shock trades only): the 5 minutes after the alert minute average < 2x usual volume
    (usual = the median of the prior 20 sessions' volume over the same minute +-2):
    B1 the grace ends at 10 min instead of 30 (the give-back may sell in 10-30 only while the bid <= the price paid)
    B2 the same at 15 min
    B3 sell at the end of those 5 minutes when the bid <= the price paid
    B4 / B5 = B1 / B3 with < 3x usual: NOT pre-set, added after the run showed < 2x catches 2 of 61 shock trades
  C 0DTE smart exit (expiry = trade day), on the minute bid of real two-sided books:
    C1 once the bid >= 3x the buy, sell when it gives back 40% from its high
    C2 3x, 25%
    C3 5x, 40%
    C4 sell half at the first bid >= 3x, the rest on the usual exit
    C5 C1 on <= 1 DTE
  D roll on a same-direction alert while the open trade is up big: at the new alert's buy minute the open leg's bid
    >= Kx the buy -> sell it at that bid and take the new alert's own trade (its 0.20 leg at the new price).
    D1 K = 3, D2 K = 2

Run: python3 exitlab.py   (from testC/, no network, no purchases)
"""
import json, sqlite3, gzip, base64, statistics as st, sys, os
from datetime import datetime, date as D
from zoneinfo import ZoneInfo
from acct import account, load, half, ret

HERE = os.path.dirname(os.path.abspath(__file__))
db = sqlite3.connect(os.path.join(HERE, 'year/d1.sqlite'))
NY = ZoneInfo('America/New_York')
STOP = 0.80          # the owner's broker safety stop, -80%
GRACE, GB, END = 30, 0.75, 360


def unz(x):
    return json.loads(gzip.decompress(base64.b64decode(x[3:])))


_bars = {}
def stock(sym, d):
    k = (sym, d)
    if k not in _bars:
        r = db.execute("select bars from minute_bars where key=? and date=?", (sym + ':sip:1Min:raw', d)).fetchone()
        y, mo, dd = map(int, d.split('-'))
        o = int(datetime(y, mo, dd, 9, 30, tzinfo=NY).timestamp())
        _bars[k] = {(b[0] - o) // 60: b for b in unz(r[0])} if r else {}
    return _bars[k]


def books(contract, d):
    r = db.execute("select quotes from option_quotes where contract=? and date=? order by source='databento' desc",
                   (contract, d)).fetchone()
    return sorted(unz(r[0])) if r else []


def obars(contract, d):
    r = db.execute("select bars from option_bars where contract=? and date=?", (contract, d)).fetchone()
    return unz(r[0]) if r else []


def book_at(rows, m):   # bookAt: the newest row at or before m, at most 4 minutes old
    best = None
    for q in rows:
        if q[0] > m: break
        best = q
    return best if best and m - best[0] < 5 else None


def two_sided(q):
    return q and q[1] > 0 and q[2] > 0 and (q[2] - q[1]) / ((q[1] + q[2]) / 2) <= 0.5


_sess = {}
def session_end(d):
    """min(endMinute, length - 30): a half day (13:00 close) ends at 180."""
    if d not in _sess:
        half_day = d in ('2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24')
        _sess[d] = 180 if half_day else END
    return _sess[d]


# ---- the usual volume around a minute (idea B) ----
_dates = sorted(r[0] for r in db.execute("select distinct date from minute_bars where key='QQQ:sip:1Min:raw'")
                if sum(1 for m in stock('QQQ', r[0]) if 0 <= m < 390) >= 200)   # sessions only
def prior_sessions(d, n=20):
    i = _dates.index(d) if d in _dates else None
    return _dates[max(0, i - n):i] if i is not None else []


def usual(sym, d, m):
    vals = []
    for p in prior_sessions(d):
        b = stock(sym, p)
        v = [b[x][5] for x in range(m - 2, m + 3) if x in b]
        if v: vals.append(sum(v) / len(v))
    return st.median(vals) if len(vals) >= 10 else None


def faded(sig, N=5, X=2.0):
    """The shock's alert minute, then N minutes whose average volume is < X times usual (None: no data)."""
    b = stock(sig['symbol'], sig['date']); am = sig['minute']
    rs = []
    for m in range(am + 1, am + N + 1):
        u = usual(sig['symbol'], sig['date'], m)
        if u is None or m not in b or u <= 0: return None
        rs.append(b[m][5] / u)
    return sum(rs) / len(rs) < X


# ---- the walk ----
def walk(sig, v, info=None):
    """-> (exitMinute, sell, reason) for trade sig under variant v (dict). info collects diagnostics."""
    t = sig['trade']; d = sig['date']; side = t['right']; unit = sig['unit']
    sb = stock(sig['symbol'], d); rows = books(t['contract'], d)
    ct = t['buyMinute']; end = session_end(d); buy = t['buy']
    ob = obars(t['contract'], d)
    b0 = next((b[0] for b in ob if ct <= b[0] <= ct + 3), ct)
    s_in = t['stockIn']; best = s_in
    stop_px = buy * (1 - STOP) if v.get('stop', True) else None
    rowm = {q[0]: q for q in rows}
    dte0 = t['expiry'] == d
    dte1 = (D.fromisoformat(t['expiry']) - D.fromisoformat(d)).days <= 1 or dte0
    trail = v.get('trail')       # (mult, give, scope)
    halfx = v.get('half')        # (mult, scope)
    in_scope = lambda sc: dte0 if sc == 0 else dte1
    hi = 0.0; half_sold = None
    grace = GRACE
    fade = v.get('fade')         # (newGrace | 'cut')
    is_faded = None
    if fade and sig['kind'] == 'shock':
        is_faded = faded(sig, X=v.get('fadeX', 2.0))
        if info is not None: info['faded'] = is_faded
    ext = v.get('extend')        # extra minutes the give-back waits while the stock is not 0.25 S30 against
    against = lambda spot: (spot < s_in) if side == 'C' else (spot > s_in)
    far_against = lambda spot: ((s_in - spot) if side == 'C' else (spot - s_in)) / s_in >= 0.25 * unit

    def done(m, px, why):
        if half_sold is not None:
            return m, (half_sold + px) / 2, why + '+half'
        return m, px, why

    for tm in range(ct + 1, end + 1):
        spot = sb[tm][4] if tm in sb else None
        if tm > b0:
            if spot: best = max(best, spot) if side == 'C' else min(best, spot)
        # the give-back (the engine's walkExit), from b0 + 1
        if tm > b0:
            el = tm - b0
            g = grace
            if is_faded and isinstance(fade, int): g = fade
            if tm >= end:
                q = book_at(rows, tm)
                return done(tm, q[1] if q else None, 'end')
            gb_hit = spot and abs(spot / best - 1) >= GB * unit
            if gb_hit and el > g:
                ok = True
                if is_faded and isinstance(fade, int) and el <= GRACE:
                    q = book_at(rows, tm); ok = bool(q) and q[1] <= buy   # only while not above the price paid
                if ext and GRACE < el <= GRACE + ext and not far_against(spot): ok = False
                if ok:
                    q = book_at(rows, tm)
                    return done(tm, q[1] if q else None, 'giveback')
            if is_faded and fade == 'cut' and tm == max(sig['minute'] + 5, b0 + 1):
                q = book_at(rows, tm)
                if q and q[1] <= buy: return done(tm, q[1], 'fadecut')
        # FLAT (follow-up 2026-11-03): W minutes after the buy, the stock has not moved X S30 the trade's way
        fl = v.get('flat')       # (W, X, scope, needBid)
        if fl and tm == ct + fl[0] and (fl[2] == 'all' or sig['kind'] == 'shock') and spot:
            ref = s_in
            if v.get('flat_ref') == 'close_ct' and ct in sb: ref = sb[ct][4]   # the 3-year proxy: the buy minute's close
            mv = ((spot / ref - 1) if side == 'C' else (1 - spot / ref)) / unit
            if info is not None: info['flat_mv'] = mv
            if mv < fl[1]:
                q = book_at(rows, tm)
                if q and (not fl[3] or q[1] <= buy): return done(tm, q[1], 'flat')
        # the broker's -80% stop: a minute book at this minute with the bid at or under 20% of the buy
        q = rowm.get(tm)
        if stop_px is not None and q and q[1] <= stop_px:
            ok = True
            if v.get('stop_two') and not two_sided(q): ok = False
            if ok and v.get('stop_stock') and not (spot and against(spot)): ok = False
            if info is not None and ok: info['stop_row'] = q; info['stop_prev'] = max([r[0] for r in rows if r[0] < tm], default=None)
            if ok: return done(tm, q[1], 'stop')
        # 0DTE: the trail and the half
        if q and two_sided(q):
            if halfx and in_scope(halfx[1]) and half_sold is None and q[1] >= halfx[0] * buy:
                half_sold = q[1]
            if trail and in_scope(trail[2]):
                hi = max(hi, q[1])
                if hi >= trail[0] * buy and q[1] <= hi * (1 - trail[1]):
                    return done(tm, q[1], 'trail')
    q = book_at(rows, end)
    return done(end, q[1] if q else None, 'end')


VARIANTS = [
    ('1.2.0 + -80% stop (base)', {}),
    ('A1 stop on a two-sided book', dict(stop_two=True)),
    ('A2 A1 + stock against the entry', dict(stop_two=True, stop_stock=True)),
    ('A3 grace +15 while not 0.25 S30 against', dict(extend=15)),
    ('A4 grace +30 while not 0.25 S30 against', dict(extend=30)),
    ('B1 faded shock: grace 10', dict(fade=10)),
    ('B2 faded shock: grace 15', dict(fade=15)),
    ('B3 faded shock: cut at +5 min if <= paid', dict(fade='cut')),
    ('B4 (post-hoc) B1 with fade < 3x usual', dict(fade=10, fadeX=3.0)),
    ('B5 (post-hoc) B3 with fade < 3x usual', dict(fade='cut', fadeX=3.0)),
    ('C1 0DTE trail 40% from the high once 3x', dict(trail=(3, 0.40, 0))),
    ('C2 0DTE trail 25% once 3x', dict(trail=(3, 0.25, 0))),
    ('C3 0DTE trail 40% once 5x', dict(trail=(5, 0.40, 0))),
    ('C4 0DTE half at 3x', dict(half=(3, 0))),
    ('C5 <=1 DTE trail 40% once 3x', dict(trail=(3, 0.40, 1))),
]
IDEA = {'A': [1, 2, 3, 4], 'B': [5, 6, 7], 'C': [10, 11, 12, 13, 14], 'D': ['D1', 'D2']}
