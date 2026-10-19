"""Entry signals: breakout + strength vs SPY, the only entry type that was positive in all four years.

For every stock in the universe and every trading day, both directions (call = up, put = down), at the
close of each 1-min bar (session minute m, 09:30 = 0):
  breakout   in the last `event_window` minutes: a new session extreme (after the first 5 minutes),
             the first close beyond the 15-min opening range, or the first close beyond yesterday's high/low
  strength   in the same window: 5-min move vs SPY x beta >= rs_jump % in the bet direction
  location   on the bet side of VWAP, and in the top (1 - range_pos_min) of the day range so far
  trend      beating SPY x beta since the open by >= ex_open_min % and over 15 min by >= ex15_min %
             (his medians, 2024-2025); none in the first 15 minutes (his opening entries lost every year)
The first minute in [first_minute, last_minute] that meets all three is the signal; one per stock per day.
The trade is entered on the next minute's option bar (sim.py).

  python3 signals.py [start] [end]     -> data/local/x/bt/signals.csv
"""
import csv, os, sys, statistics as st
from store import P, DATA, day, calendar

E = P["entry"]


def series(bars):
    """Closes, highs, lows and volumes for minutes 0..389, carried forward over missing bars."""
    by = {b[0]: b for b in bars}
    c, h, l, v, last = [], [], [], [], None
    for m in range(390):
        b = by.get(m)
        if b: last = b
        if last is None: c.append(None); h.append(None); l.append(None); v.append(0); continue
        c.append(last[4]); h.append(last[2] if b else last[4]); l.append(last[3] if b else last[4]); v.append(b[5] if b else 0)
    return c, h, l, v


_beta = {}


def beta(sym, date, cal_idx, cal):
    """Beta to SPY from 5-min returns over the prior 20 sessions."""
    k = (sym, date)
    if k in _beta: return _beta[k]
    xs, ys = [], []
    for d in cal[max(0, cal_idx - 20):cal_idx]:
        sc, ss = series(day(sym, d))[0], series(day("SPY", d))[0]
        for m in range(5, 390, 5):
            if sc[m] and sc[m - 5] and ss[m] and ss[m - 5]:
                ys.append(sc[m] / sc[m - 5] - 1); xs.append(ss[m] / ss[m - 5] - 1)
    b = None
    if len(xs) > 300:
        mx, my = st.fmean(xs), st.fmean(ys)
        var = sum((x - mx) ** 2 for x in xs)
        b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / var if var else None
    _beta[k] = b
    return b


class Day:
    """One stock on one day in one direction: per-minute events and state (used by sim.py too)."""

    def __init__(self, sym, date, bet, cal, cal_idx):
        self.sym, self.date, self.bet = sym, date, bet
        bars = day(sym, date)
        self.ok = len(bars) > 300 and cal_idx > 0
        if not self.ok: return
        c, h, l, v = series(bars)
        spy = series(day("SPY", date))[0]
        pb = day(sym, cal[cal_idx - 1])
        prev_hi = max((b[2] for b in pb), default=None)
        prev_lo = min((b[3] for b in pb), default=None)
        self.prev_close = pb[-1][4] if pb else None
        self.open = bars[0][1] if bars[0][0] <= 5 else None
        self.close = c[-1]
        self.beta = beta(sym, date, cal_idx, cal)
        self.c = c
        orh = max(x for x in h[:15] if x) if any(h[:15]) else None
        orl = min(x for x in l[:15] if x) if any(l[:15]) else None
        self.ex15, self.ex_open, self.breakout, self.rs, self.vwap_ok, self.range_pos, self.last_ext = [], [], [], [], [], [], []
        hi, lo, pv, vv, or_done, prev_done, last_ext = -1e18, 1e18, 0.0, 0.0, False, False, 0
        for m in range(390):
            x = c[m]
            if x is None:
                self.ex15.append(None); self.ex_open.append(None); self.breakout.append(False); self.rs.append(None); self.vwap_ok.append(False); self.range_pos.append(None); self.last_ext.append(last_ext)
                continue
            pv += (h[m] + l[m] + x) / 3 * v[m]; vv += v[m]
            vw = pv / vv if vv else x
            beyond = x > hi if bet > 0 else x < lo
            bo = m >= 5 and beyond
            if beyond: last_ext = m
            hi, lo = max(hi, h[m]), min(lo, l[m])
            if m >= 15 and not or_done and orh and (x > orh if bet > 0 else x < orl):
                bo = True; or_done = True
            if prev_hi and not prev_done and (x > prev_hi if bet > 0 else x < prev_lo):
                bo = True; prev_done = True
            rs = ex15 = exo = None
            if self.beta is not None and spy[m]:
                if m >= 15 and c[m - 15] and spy[m - 15]:
                    ex15 = bet * ((x / c[m - 15] - 1) - self.beta * (spy[m] / spy[m - 15] - 1)) * 100
                if self.open and spy[0]:
                    exo = bet * ((x / self.open - 1) - self.beta * (spy[m] / spy[0] - 1)) * 100
            if m >= 5 and c[m - 5] and spy[m] and spy[m - 5] and self.beta is not None:
                rs = bet * ((x / c[m - 5] - 1) - self.beta * (spy[m] / spy[m - 5] - 1)) * 100
            self.breakout.append(bo); self.rs.append(rs); self.ex15.append(ex15); self.ex_open.append(exo)
            self.vwap_ok.append(x > vw if bet > 0 else x < vw)
            self.range_pos.append(((x - lo) / (hi - lo) if bet > 0 else (hi - x) / (hi - lo)) if hi > lo else None)
            self.last_ext.append(last_ext)

    def signal(self):
        w = E["event_window"]
        for m in range(E["first_minute"], E["last_minute"] + 1):
            win = range(max(0, m - w + 1), m + 1)
            if not any(self.breakout[i] for i in win): continue
            if not any((self.rs[i] or -9) >= E["rs_jump"] for i in win): continue
            if E["vwap_side"] and not self.vwap_ok[m]: continue
            if (self.range_pos[m] or 0) < E["range_pos_min"]: continue
            if (self.ex_open[m] or -9) < E["ex_open_min"] or (self.ex15[m] or -9) < E["ex15_min"]: continue
            return m
        return None


def main(start, end):
    cal = calendar()
    out = []
    for i, date in enumerate(cal):
        if not (start <= date <= end): continue
        for sym in P["universe"]:
            best = None
            for bet in (1, -1):
                d = Day(sym, date, bet, cal, i)
                if not d.ok: continue
                m = d.signal()
                if m is not None and (best is None or m < best[1]): best = (bet, m, d)
            if best:
                bet, m, d = best
                out.append(dict(date=date, sym=sym, right="C" if bet > 0 else "P", minute=m,
                                time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}", price=d.c[m],
                                rs=round(d.rs[m] or 0, 2), ex15=round(d.ex15[m], 2), ex_open=round(d.ex_open[m], 2), range_pos=round(d.range_pos[m], 2), beta=round(d.beta, 2)))
        print(date, len(out), flush=True) if date.endswith("-01") or date == end else None
    with open(os.path.join(DATA, "signals.csv"), "w") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
    print(len(out), "signals ->", os.path.join(DATA, "signals.csv"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else P["train"][0], sys.argv[2] if len(sys.argv) > 2 else P["train"][1])
