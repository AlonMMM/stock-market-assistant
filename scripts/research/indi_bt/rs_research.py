"""Which measure of strength vs SPY predicts what the stock does next?

At sampled minutes (every 15 minutes, 10:00-15:45) on every universe stock and day, nine measures of
strength vs SPY x beta (positive = stronger than SPY), and what came next, also vs SPY x beta:

  ex15        15-minute excess return (what the signal uses)
  ex_open     excess return since the open (what the signal uses)
  ex_prev     excess return since yesterday's close (gap included)
  consist     share of 5-minute steps since the open in which the stock beat SPY x beta
  tstat       t-statistic of those 5-minute excess returns (drift / noise)
  down_beat   excess return summed over the 5-minute steps in which SPY fell (holds up when SPY drops)
  z_open      ex_open divided by the stock's usual daily excess move (20-day standard deviation)
  ex_5d       excess return over the previous 5 sessions (close to close, before today)
  ex_20d      the same over 20 sessions

Next: f30 / f60 (excess return over the next 30 / 60 minutes), f_close (to the close), f_gap (close to
the next day's open, for samples at 15:45).

Score: for each day, the rank correlation across stocks between a measure and what came next (the
"daily IC"), averaged over days, with a t-statistic over days; and the average next return of the
strongest fifth minus the weakest fifth of stocks, in basis points.

  python3 rs_research.py 2024-02-01 2024-12-31 [out.csv]
"""
import csv, math, statistics as st, sys
from store import P, day, calendar
from signals import series, beta

STEP = 5


def daily_closes(sym, cal, i, n):
    out = []
    for d in cal[max(0, i - n):i + 1]:
        b = day(sym, d)
        out.append(b[-1][4] if b else None)
    return out


def ranks(x):
    o = sorted(range(len(x)), key=lambda i: x[i])
    r = [0.0] * len(x)
    for k, i in enumerate(o): r[i] = k
    return r


def spearman(a, b):
    if len(a) < 8: return None
    ra, rb = ranks(a), ranks(b)
    ma, mb = st.fmean(ra), st.fmean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return num / den if den else None


MEAS = ["ex15", "ex_open", "ex_prev", "consist", "tstat", "down_beat", "z_open", "ex_5d", "ex_20d"]
FWD = ["f30", "f60", "f_close", "f_gap"]


def rows_for_day(cal, i):
    date = cal[i]
    spy = series(day("SPY", date))[0]
    spy_prev = day("SPY", cal[i - 1])
    if not spy[0] or not spy_prev: return []
    spy_pc = spy_prev[-1][4]
    nxt = cal[i + 1] if i + 1 < len(cal) else None
    spy_next_open = day("SPY", nxt)[0][1] if nxt and day("SPY", nxt) else None
    spy_d = daily_closes("SPY", cal, i - 1, 21)
    out = []
    for sym in P["universe"]:
        bars = day(sym, date)
        if len(bars) < 300: continue
        c = series(bars)[0]
        b = beta(sym, date, i, cal)
        prev = day(sym, cal[i - 1])
        if b is None or not prev or not c[0]: continue
        pc = prev[-1][4]
        xr = lambda s0, s1, q0, q1: (s1 / s0 - 1) - b * (q1 / q0 - 1)
        sd = daily_closes(sym, cal, i - 1, 21)
        dex = [xr(sd[k - 1], sd[k], spy_d[k - 1], spy_d[k]) for k in range(1, len(sd)) if sd[k - 1] and sd[k] and spy_d[k - 1] and spy_d[k]]
        dsd = st.pstdev(dex) if len(dex) >= 10 else None
        nb = day(sym, nxt) if nxt else []
        for m in range(30, 376, 15):
            if not (c[m] and spy[m] and c[m - 15] and spy[m - 15]): continue
            steps = [xr(c[k - STEP], c[k], spy[k - STEP], spy[k]) for k in range(STEP, m + 1, STEP) if c[k] and c[k - STEP] and spy[k] and spy[k - STEP]]
            spys = [spy[k] / spy[k - STEP] - 1 for k in range(STEP, m + 1, STEP) if c[k] and c[k - STEP] and spy[k] and spy[k - STEP]]
            if len(steps) < 6: continue
            sdv = st.pstdev(steps)
            r = dict(date=date, sym=sym, minute=m,
                     ex15=xr(c[m - 15], c[m], spy[m - 15], spy[m]) * 100,
                     ex_open=xr(c[0], c[m], spy[0], spy[m]) * 100,
                     ex_prev=xr(pc, c[m], spy_pc, spy[m]) * 100,
                     consist=sum(s > 0 for s in steps) / len(steps),
                     tstat=st.fmean(steps) / sdv * math.sqrt(len(steps)) if sdv else 0.0,
                     down_beat=sum(s for s, q in zip(steps, spys) if q < 0) * 100,
                     z_open=xr(c[0], c[m], spy[0], spy[m]) / dsd if dsd else None,
                     ex_5d=(sum(dex[-5:]) * 100) if len(dex) >= 5 else None,
                     ex_20d=(sum(dex) * 100) if len(dex) >= 20 else None)
            if m + 30 < 390 and c[m + 30] and spy[m + 30]: r["f30"] = xr(c[m], c[m + 30], spy[m], spy[m + 30]) * 100
            if m + 60 < 390 and c[m + 60] and spy[m + 60]: r["f60"] = xr(c[m], c[m + 60], spy[m], spy[m + 60]) * 100
            if c[389] and spy[389]: r["f_close"] = xr(c[m], c[389], spy[m], spy[389]) * 100
            if m == 375 and nb and spy_next_open and c[389] and spy[389]:
                r["f_gap"] = xr(c[389], nb[0][1], spy[389], spy_next_open) * 100
            out.append(r)
    return out


def score(rows):
    by = {}
    for r in rows: by.setdefault((r["date"], r["minute"]), []).append(r)
    res = {}
    for mname in MEAS:
        for f in FWD:
            ics, spreads = [], []
            for g in by.values():
                g = [r for r in g if r.get(mname) is not None and r.get(f) is not None]
                if len(g) < 10: continue
                ic = spearman([r[mname] for r in g], [r[f] for r in g])
                if ic is None: continue
                ics.append(ic)
                g.sort(key=lambda r: r[mname]); q = max(1, len(g) // 5)
                spreads.append(st.fmean(r[f] for r in g[-q:]) - st.fmean(r[f] for r in g[:q]))
            if len(ics) > 5:
                res[(mname, f)] = (st.fmean(ics), st.fmean(ics) / (st.pstdev(ics) / math.sqrt(len(ics))) if st.pstdev(ics) else 0, st.fmean(spreads) * 100, len(ics))
    return res


def main(a, b, out=None):
    cal = calendar()
    rows = []
    for i, d in enumerate(cal):
        if a <= d <= b and i >= 21: rows += rows_for_day(cal, i)
    if out:
        with open(out, "w") as f:
            w = csv.DictWriter(f, fieldnames=["date", "sym", "minute"] + MEAS + FWD); w.writeheader(); w.writerows(rows)
    res = score(rows)
    print(f"{len(rows):,} samples, {a} to {b}\n")
    print("| Measure | " + " | ".join(f"{f}: IC (t) / top-bottom bp" for f in FWD) + " |")
    print("|---|" + "---|" * len(FWD))
    for mname in MEAS:
        cells = []
        for f in FWD:
            v = res.get((mname, f))
            cells.append(f"{v[0]:+.3f} ({v[1]:+.1f}) / {v[2]:+.0f}" if v else "")
        print(f"| {mname} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
