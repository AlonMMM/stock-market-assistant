"""The Main bot's strength per minute for any stock and day, as defence_signals.py measures it: t (the t-stat of the
stock's excess 1-minute returns over SPY x beta since the open; a put reads -t) and D2 (over the last 30 minutes, the
excess move on SPY's bad minutes, in S30 units: for a call the SPY-down minutes, for a put the SPY-up ones).
  of(sym, date) -> {minute: (t, d2_call, d2_put)} or {}
"""
import collections, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import day, calendar
from signals import series, beta
from levels import ctx

CAL = calendar()
WINDOW, MIN_STEPS = 30, 10
_cache = {}


def of(sym, date):
    if (sym, date) in _cache: return _cache[(sym, date)]
    out = {}
    _cache.clear(); _cache[(sym, date)] = out
    i = CAL.index(date) if date in CAL else -1
    bars = day(sym, date)
    if i < 21 or len(bars) <= 300: return out
    b_ = beta(sym, date, i, CAL); cx = ctx(sym, date)
    if b_ is None or not cx or not cx.get("sd"): return out
    unit = cx["sd"]
    c = series(bars)[0]; spy = series(day("SPY", date))[0]
    n = s1 = s2 = 0.0
    win = collections.deque(); ec_s = ep_s = 0.0
    for m in range(1, 390):
        ec = ep = 0.0
        if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            rs = c[m] / c[m - 1] - 1; rp = spy[m] / spy[m - 1] - 1
            x = rs - b_ * rp
            n += 1; s1 += x; s2 += x * x
            if rp < 0: ec = x / unit
            if rp > 0: ep = -x / unit
        win.append((ec, ep)); ec_s += ec; ep_s += ep
        if len(win) > WINDOW:
            a, b = win.popleft(); ec_s -= a; ep_s -= b
        if n < MIN_STEPS: continue
        mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
        out[m] = (mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0, ec_s, ep_s)
    return out
