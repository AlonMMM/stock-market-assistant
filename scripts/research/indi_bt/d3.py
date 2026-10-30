"""D3: how much a stock joins SPY's drops, the way Indi reads it (the user, 2026-10-30, "Yes try create d3", after D2 was
shown to sum every small SPY-down minute and to flag stocks that simply do not follow SPY, WMT 54% of days >= 2).

His words: "I always measure a stock against the market ... when the market started its correction, Apple barely took
part in the decline (ellipse 1) and came back to a new high" (2023-07-02); "SPY sold off and I saw ROKU not reacting to
the decline" (2023-11-15, ten minutes before the close). He circles a few SPY drops on the chart, not every minute.

  swings   SPY's down swings so far today (a put: up swings): a zigzag on SPY's minute closes that turns when SPY moves
           back by `thr` = SPY's own usual 30-minute move (levels.ctx S30) from the last extreme; a swing is peak -> trough
           of at least `thr`
  joined   over those swings: the stock's move / (beta x SPY's move), weighted by the swing size (1 = fell as beta says,
           0 = did not move, < 0 = rose while SPY fell)
  held     1 - joined (the bigger, the more it ignored the drops)
  d3       held today - the stock's median held over the 20 sessions before (full days): a stock that never follows SPY
           (WMT, USO) gets no credit for it, only for ignoring today's drops more than it usually does
  last     the same for the latest swing only (his "ellipse": the drop right before he looks), d3_last = last - base
A swing still open at minute m counts up to m. No swing today -> None.
"""
import functools, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import day, calendar
from signals import beta
from levels import ctx

CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}


def closes(sym, date):
    c = [None] * 390
    for x in day(sym, date):
        if 0 <= x[0] < 390: c[x[0]] = x[4]
    for m in range(1, 390):
        if c[m] is None: c[m] = c[m - 1]
    return c


@functools.lru_cache(maxsize=4096)
def spy_swings(date, side):
    """SPY's swings against `side` ("C": down swings, "P": up swings) on date: [(peak minute, trough minute)]."""
    s = closes("SPY", date)
    cx = ctx("SPY", date)
    if not cx or not cx["sd"] or s[0] is None: return []
    thr = cx["sd"]
    bet = 1 if side == "C" else -1
    out, ext_m, mode = [], 0, 0   # mode 1: looking for the trough of a swing against us, 0: for its peak
    peak_m = 0
    for m in range(1, 390):
        if s[m] is None: continue
        v = bet * (s[m] / s[0] - 1); pv = bet * (s[peak_m] / s[0] - 1)
        if mode == 0:
            if v > pv: peak_m = m
            elif pv - v >= thr: mode, ext_m = 1, m
        else:
            ev = bet * (s[ext_m] / s[0] - 1)
            if v < ev: ext_m = m
            elif v - ev >= thr:
                out.append((peak_m, ext_m)); mode, peak_m = 0, m
    if mode == 1: out.append((peak_m, ext_m))
    return out


def held(sym, date, m, side, last=False):
    """(held, swings counted) up to minute m (last: the latest swing only), or (None, 0)."""
    i = IDX.get(date)
    if i is None: return None, 0
    b = beta(sym, date, i, CAL)
    if b is None or b <= 0.05: return None, 0
    c, s = closes(sym, date), closes("SPY", date)
    num = den = 0.0; n = 0
    sw = [x for x in spy_swings(date, side) if x[0] < m]
    if last: sw = sw[-1:]
    for a, z in sw:
        z = min(z, m)
        if None in (c[a], c[z], s[a], s[z]) or z <= a: continue
        sm = s[z] / s[a] - 1
        if (side == "C" and sm >= 0) or (side == "P" and sm <= 0): continue
        num += (c[z] / c[a] - 1); den += b * sm; n += 1
    if not n or den == 0: return None, 0
    return max(-3.0, min(3.0, 1 - num / den)), n


@functools.lru_cache(maxsize=65536)
def full_held(sym, date, side):
    return held(sym, date, 389, side)[0]


def d3(sym, date, m, side):
    """dict(held, n, base, d3) at minute m, or None."""
    h, n = held(sym, date, m, side)
    if h is None: return None
    hl, _ = held(sym, date, m, side, last=True)
    i = IDX[date]
    past = [x for x in (full_held(sym, d, side) for d in CAL[max(0, i - 20):i]) if x is not None]
    if len(past) < 8: return None
    base = st.median(past)
    return dict(held=h, n=n, base=base, d3=h - base, last=hl, d3_last=None if hl is None else hl - base)
