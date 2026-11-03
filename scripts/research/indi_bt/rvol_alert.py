"""The site's volume alert (rvol-v6, packages/alerts/src/relative-volume.ts) on the backtest's regular-session 1-minute
bars: per minute, 'up' / 'down' when the alert condition holds, else None. Shared by alert_gate.py, alert_add.py, zero5.py
and sim.py (the alert-silence exit). Deviations from the live engine: regular hours only, >= 10 prior sessions instead of
exactly 20, no cooldown or fresh-crossing (the bot reads evaluations)."""
import os
from store import day

# The alert's rule (rvol-v6 defaults).
WIN, THRESHOLD, PACE, MIN_VOL, PRICE_MULT, MIN_MOVE = 3, 4.0, 4.0, 10000, 3.0, 0.5
PACE_SKIP_OPEN, PACE_SKIP_CLOSE, PACE_MIN_MINUTES = 30, 30, 15
# The stock's volume against SPY's (the user, 2026-11-03: "add more trade we can catch more gaint"): one more way to pass
# the volume test, the stock's ratio >= REL_FLOOR and the stock's ratio / SPY's ratio >= REL_K (each ratio = the 3-minute
# window over its median at that minute over the prior sessions). Off unless RV_REL_K is set.
REL_K = float(os.environ["RV_REL_K"]) if os.environ.get("RV_REL_K") else None
REL_FLOOR = float(os.environ.get("RV_REL_FLOOR", "2"))


def med(v):
    v = sorted(v); k = len(v) // 2
    return v[k] if len(v) % 2 else (v[k - 1] + v[k]) / 2


def windows(bars):
    """Per minute m: (window volume, |move| %) over bars m-2..m against the close at m-3, when those bars are all
    present and contiguous; else None. Also the opens, closes, volumes and a presence flag by minute."""
    by = {b[0]: b for b in bars}
    out = [None] * 390
    for m in range(WIN, 390):
        if all(k in by for k in range(m - WIN, m + 1)):
            vol = sum(by[k][5] for k in range(m - WIN + 1, m + 1))
            move = abs(by[m][4] / by[m - WIN][4] - 1) * 100
            out[m] = (vol, move)
    return out, by


def ratios(w, hist):
    """Per minute: the window's volume over its median in the prior sessions (None: under 10 samples)."""
    out = [None] * 390
    for m in range(390):
        samples = [h[m][0] for h in hist if h[m] is not None]
        if w[m] is None or len(samples) < 10: continue
        e = med(samples)
        if e > 0: out[m] = w[m][0] / e
    return out


def alerts(bars, hist, spy=None):
    """The alert's direction ('up' / 'down') or None at each minute of a day; hist: prior days' windows(); spy: SPY's
    ratios() that day (the stock-against-SPY rule, with REL_K)."""
    w, by = windows(bars)
    out = [None] * 390
    pace_vol, pace_n = 0, 0            # today's pace zone before the window
    pace = lambda m: PACE_SKIP_OPEN <= m <= 389 - PACE_SKIP_CLOSE
    for m in range(390):
        b = by.get(m)
        # pace zone volume up to and including the bar before the window (m - WIN)
        k = m - WIN
        if k >= 0 and pace(k) and k in by: pace_vol += by[k][5]; pace_n += 1
        if w[m] is None or b is None: continue
        actual, move = w[m]
        samples = [h[m] for h in hist if h[m] is not None]
        if len(samples) < 10: continue
        expected, expected_move = med([s[0] for s in samples]), med([s[1] for s in samples])
        ratio = actual / expected if expected > 0 else None
        in_pace = all(pace(k) for k in range(m - WIN + 1, m + 1))
        pace_ratio = actual / (pace_vol / pace_n * WIN) if in_pace and pace_n >= PACE_MIN_MINUTES and pace_vol > 0 else None
        volume_ok = (ratio is not None and ratio >= THRESHOLD) or (pace_ratio is not None and pace_ratio >= PACE)
        if REL_K is not None and spy and spy[m] and ratio is not None and ratio >= REL_FLOOR and ratio / spy[m] >= REL_K: volume_ok = True
        move_ok = move >= PRICE_MULT * expected_move and move >= MIN_MOVE
        if not (volume_ok and move_ok and actual >= MIN_VOL): continue
        prev = by[m - 1][4]
        if b[4] > prev and b[4] > b[1]: out[m] = "up"
        elif b[4] < prev and b[4] < b[1]: out[m] = "down"
    return out



_cache = {}


def alerts_for(sym, date, cal):
    """The alert series of one stock-day, cached (the prior 20 sessions' windows are computed once per stock)."""
    k = (sym, date)
    if k not in _cache:
        if len(_cache) > 5000: _cache.clear()
        i = cal.index(date)
        spy = ratios(_windows("SPY", date), [_windows("SPY", d) for d in cal[i - 20:i]]) if REL_K is not None else None
        _cache[k] = alerts(day(sym, date), [_windows(sym, d) for d in cal[i - 20:i]], spy)
    return _cache[k]


_w = {}


def _windows(sym, d):
    if (sym, d) not in _w:
        if len(_w) > 20000: _w.clear()
        _w[(sym, d)] = windows(day(sym, d))[0]
    return _w[(sym, d)]
