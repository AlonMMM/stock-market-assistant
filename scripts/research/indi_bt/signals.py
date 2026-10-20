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

  python3 signals.py [start] [end] [calm|retest]   -> data/local/x/bt/signals[_mode].csv
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
        self.cal, self.cal_idx, self.rv = cal, cal_idx, None
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
        self.kinds = []
        self.ex15, self.ex_open, self.breakout, self.rs, self.vwap_ok, self.range_pos, self.last_ext = [], [], [], [], [], [], []
        hi, lo, pv, vv, or_done, prev_done, last_ext = -1e18, 1e18, 0.0, 0.0, False, False, 0
        for m in range(390):
            x = c[m]
            if x is None:
                self.kinds.append(set()); self.ex15.append(None); self.ex_open.append(None); self.breakout.append(False); self.rs.append(None); self.vwap_ok.append(False); self.range_pos.append(None); self.last_ext.append(last_ext)
                continue
            pv += (h[m] + l[m] + x) / 3 * v[m]; vv += v[m]
            vw = pv / vv if vv else x
            beyond = x > hi if bet > 0 else x < lo
            bo = m >= 5 and beyond
            kinds = {"new_high"} if bo else set()
            if beyond: last_ext = m
            hi, lo = max(hi, h[m]), min(lo, l[m])
            if m >= 15 and not or_done and orh and (x > orh if bet > 0 else x < orl):
                bo = True; or_done = True; kinds.add("or_break")
            if prev_hi and not prev_done and (x > prev_hi if bet > 0 else x < prev_lo):
                bo = True; prev_done = True; kinds.add("prev_break")
            rs = ex15 = exo = None
            if self.beta is not None and spy[m]:
                if m >= 15 and c[m - 15] and spy[m - 15]:
                    ex15 = bet * ((x / c[m - 15] - 1) - self.beta * (spy[m] / spy[m - 15] - 1)) * 100
                if self.open and spy[0]:
                    exo = bet * ((x / self.open - 1) - self.beta * (spy[m] / spy[0] - 1)) * 100
            if m >= 5 and c[m - 5] and spy[m] and spy[m - 5] and self.beta is not None:
                rs = bet * ((x / c[m - 5] - 1) - self.beta * (spy[m] / spy[m - 5] - 1)) * 100
            self.kinds.append(kinds); self.breakout.append(bo); self.rs.append(rs); self.ex15.append(ex15); self.ex_open.append(exo)
            self.vwap_ok.append(x > vw if bet > 0 else x < vw)
            self.range_pos.append(((x - lo) / (hi - lo) if bet > 0 else (hi - x) / (hi - lo)) if hi > lo else None)
            self.last_ext.append(last_ext)

    def why(self, m):
        """Plain-words reasons for an entry at minute m (what the rules saw)."""
        w = E["event_window"]; up = self.bet > 0
        hm = lambda i: f"{(570 + i) // 60:02d}:{(570 + i) % 60:02d}"
        names = {"prev_break": f"broke yesterday's {'high' if up else 'low'}", "or_break": f"broke the 15-minute opening {'high' if up else 'low'}",
                 "new_high": f"made a new day {'high' if up else 'low'}"}
        ev = {}
        for i in range(max(0, m - w + 1), m + 1):
            for k in self.kinds[i]: ev[k] = i
        parts = [f"{names[k]} at {hm(i)}" for k, i in sorted(ev.items(), key=lambda x: x[1])]
        rs = max((self.rs[i] for i in range(max(0, m - w + 1), m + 1) if self.rs[i] is not None), default=None)
        out = (", ".join(parts) or "no breakout in the last 5 minutes").capitalize()
        if rs is not None: out += f"; {'up' if up else 'down'} {abs(rs):.1f}% vs SPY×β in 5 minutes"
        word = lambda v: f"{abs(v):.1f}% {'stronger' if (v >= 0) == up else 'weaker'} than SPY×β"
        if self.ex_open[m] is not None: out += f"; {word(self.ex_open[m] if up else -self.ex_open[m])} since the open"
        if self.ex15[m] is not None: out += f", {word(self.ex15[m] if up else -self.ex15[m])} over 15 minutes"
        if self.range_pos[m] is not None: out += f"; at {self.range_pos[m]:.2f} of the day range"
        out += f", {'above' if self.vwap_ok[m] == up else 'below'} VWAP" if up else f", {'below' if self.vwap_ok[m] else 'above'} VWAP"
        return out

    def rv_signal(self, V, cal, cal_idx):
        """First minute with strength + relative volume + breakout (entry_variants.rv)."""
        import math
        bars = day(self.sym, self.date)
        vol = [0] * 390
        for b in bars: vol[b[0]] = b[5]
        cum = [0] * 390; s_ = 0
        for m in range(390): s_ += vol[m]; cum[m] = s_
        hist = []
        for d in cal[max(0, cal_idx - 20):cal_idx]:
            v = [0] * 390
            for b in day(self.sym, d): v[b[0]] = b[5]
            c_ = [0] * 390; t_ = 0
            for m in range(390): t_ += v[m]; c_[m] = t_
            if c_[-1] > 0: hist.append(c_)
        if len(hist) < 10 or self.beta is None: return None
        spy = series(day("SPY", self.date))[0]
        c, bet = self.c, self.bet
        steps = []
        pb = day(self.sym, cal[cal_idx - 1])
        phi, plo = max(x[2] for x in pb), min(x[3] for x in pb)
        for m in range(5, E["last_minute"] + 1):
            if m % 5 == 0 and c[m] and c[m - 5] and spy[m] and spy[m - 5]:
                steps.append(bet * ((c[m] / c[m - 5] - 1) - self.beta * (spy[m] / spy[m - 5] - 1)))
            if m < V["first_minute"] or len(steps) < 6 or c[m] is None: continue
            sd = st.pstdev(steps)
            if not sd or st.fmean(steps) / sd * math.sqrt(len(steps)) < V["strength_t"]: continue
            if (self.range_pos[m] or 0) < V["range_pos"]: continue
            if V["need_prev_out"] and not (c[m] > phi if bet > 0 else c[m] < plo): continue
            med_cum = st.median(h[m] for h in hist)
            med_15 = st.median(h[m] - h[m - 15] for h in hist)
            if not med_cum or cum[m] / med_cum < V["rvol_day"]: continue
            if not med_15 or (cum[m] - cum[m - 15]) / med_15 < V["rvol_15"]: continue
            self.rv = dict(rvol_day=round(cum[m] / med_cum, 2), rvol_15=round((cum[m] - cum[m - 15]) / med_15, 2),
                           strength=round(st.fmean(steps) / sd * math.sqrt(len(steps)), 2))
            return m
        return None

    def signal(self, mode=None):
        """First entry minute of the day, or None. mode: None (enter on the signal), "calm" or "retest"
        (see params.json entry_variants)."""
        V = P["entry_variants"].get(mode, {})
        if mode == "rv": return self.rv_signal(V, self.cal, self.cal_idx)
        w = E["event_window"]
        for m in range(E["first_minute"], E["last_minute"] + 1):
            win = range(max(0, m - w + 1), m + 1)
            if not any(self.breakout[i] for i in win): continue
            if not any((self.rs[i] or -9) >= E["rs_jump"] for i in win): continue
            if E["vwap_side"] and not self.vwap_ok[m]: continue
            if (self.range_pos[m] or 0) < E["range_pos_min"]: continue
            if (self.ex_open[m] or -9) < E["ex_open_min"] or (self.ex15[m] or -9) < E["ex15_min"]: continue
            if mode == "calm" and self.c[m - 15] and self.bet * (self.c[m] / self.c[m - 15] - 1) * 100 > V["max_move15"]: continue
            if mode == "retest": return self.retest(m, V)
            return m
        return None

    def retest(self, s, V):
        """After a signal at s: the first turn back after a pullback of retest_frac of the run-up."""
        c, b = self.c, self.bet
        base = min((x for x in c[s - 15:s + 1] if x), key=lambda x: b * x)  # the run-up's start
        ext, pulled = c[s], False
        for m in range(s + 1, min(s + V["retest_window"], E["last_minute"]) + 1):
            if c[m] is None: continue
            if b * (c[m] - ext) > 0: ext = c[m]
            run = b * (ext - base)
            if run > 0 and b * (ext - c[m]) >= V["retest_frac"] * run: pulled = True
            if pulled and c[m - 1] and b * (c[m] - c[m - 1]) > 0 and self.vwap_ok[m] and b * (c[m] - base) > 0:
                return m
        return None


def main(start, end, mode=None):
    cal = calendar()
    out = []
    for i, date in enumerate(cal):
        if not (start <= date <= end): continue
        for sym in P["universe"]:
            best = None
            for bet in (1, -1):
                d = Day(sym, date, bet, cal, i)
                if not d.ok: continue
                m = d.signal(mode)
                if m is not None and (best is None or m < best[1]): best = (bet, m, d)
            if best:
                bet, m, d = best
                out.append(dict(**(d.rv or {}), date=date, sym=sym, right="C" if bet > 0 else "P", minute=m,
                                time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}", price=d.c[m],
                                rs=round(d.rs[m] or 0, 2), ex15=round(d.ex15[m], 2), ex_open=round(d.ex_open[m], 2), range_pos=round(d.range_pos[m], 2), beta=round(d.beta, 2)))
        print(date, len(out), flush=True) if date.endswith("-01") or date == end else None
    with open(os.path.join(DATA, f"signals{'_' + mode if mode else ''}.csv"), "w") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
    print(len(out), "signals ->", os.path.join(DATA, "signals.csv"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else P["train"][0], sys.argv[2] if len(sys.argv) > 2 else P["train"][1],
         sys.argv[3] if len(sys.argv) > 3 else None)
