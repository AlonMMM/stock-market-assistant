"""Strength + relative volume + breakout: does the combination predict what comes next?

At sampled minutes (every 15 minutes, 10:00-15:45) on every universe stock and day. Direction = the
side the stock is beating SPY x beta since the open (up = calls, down = puts); everything below is
measured in that direction.

  strength   t-statistic of today's 5-minute excess returns vs SPY x beta (consistency), in the direction
  rvol_day   volume since the open / the median of the same span over the previous 20 sessions
  rvol_15    last 15 minutes' volume / median of those minutes over the previous 20 sessions
  at_ext     at >= 0.9 of the day range, on the direction's side
  prev_out   beyond yesterday's high (up) or low (down)
  new_ext15  made a new day extreme in the last 15 minutes

What came next, in the direction: excess return vs SPY x beta over 60 minutes, to the close and from
the close to the next open (15:45 samples), in basis points; how often it was positive; and the
stock's plain move over 60 minutes in the direction (what a call or put feels), in basis points.

  python3 rv_research.py 2024-02-01 2024-12-31
"""
import math, statistics as st, sys
from store import P, day, calendar
from signals import series, beta

STEP = 5
SAMPLES = list(range(30, 376, 15))


def cumvol(bars):
    v = [0] * 390
    for b in bars:
        if 0 <= b[0] < 390: v[b[0]] = b[5]
    out, s = [], 0
    for x in v: s += x; out.append(s)
    return v, out


def day_rows(cal, i):
    date = cal[i]
    spy = series(day("SPY", date))[0]
    if not spy[0]: return []
    nxt = cal[i + 1] if i + 1 < len(cal) else None
    sn = day("SPY", nxt) if nxt else []
    out = []
    for sym in P["universe"]:
        bars = day(sym, date)
        if len(bars) < 300: continue
        c, h, l, _ = series(bars)
        b = beta(sym, date, i, cal)
        prev = day(sym, cal[i - 1])
        if b is None or not prev or not c[0]: continue
        phi, plo = max(x[2] for x in prev), min(x[3] for x in prev)
        v1, cv = cumvol(bars)
        hist = [cumvol(day(sym, d)) for d in cal[max(0, i - 20):i]]
        hist = [hv for hv in hist if hv[1][-1] > 0]
        if len(hist) < 10: continue
        xr = lambda s0, s1, q0, q1: (s1 / s0 - 1) - b * (q1 / q0 - 1)
        nb = day(sym, nxt) if nxt else []
        dirs_ext = {1: 0, -1: 0}
        run_hi, run_lo = -1e18, 1e18
        ext_at = {1: [], -1: []}
        for m in range(390):
            if c[m] is None: ext_at[1].append(dirs_ext[1]); ext_at[-1].append(dirs_ext[-1]); continue
            if m >= 5 and c[m] > run_hi: dirs_ext[1] = m
            if m >= 5 and c[m] < run_lo: dirs_ext[-1] = m
            run_hi, run_lo = max(run_hi, h[m]), min(run_lo, l[m])
            ext_at[1].append(dirs_ext[1]); ext_at[-1].append(dirs_ext[-1])
        for m in SAMPLES:
            if not (c[m] and spy[m]): continue
            exo = xr(c[0], c[m], spy[0], spy[m])
            d = 1 if exo >= 0 else -1
            steps = [d * xr(c[k - STEP], c[k], spy[k - STEP], spy[k]) for k in range(STEP, m + 1, STEP) if c[k] and c[k - STEP] and spy[k] and spy[k - STEP]]
            if len(steps) < 6: continue
            sd = st.pstdev(steps)
            hi_, lo_ = max(x for x in h[:m + 1] if x), min(x for x in l[:m + 1] if x)
            rp = ((c[m] - lo_) / (hi_ - lo_) if d > 0 else (hi_ - c[m]) / (hi_ - lo_)) if hi_ > lo_ else 0.5
            med_cum = st.median(hv[1][m] for hv in hist)
            med_15 = st.median(hv[1][m] - hv[1][m - 15] for hv in hist)
            r = dict(date=date, sym=sym, minute=m, dir=d,
                     strength=st.fmean(steps) / sd * math.sqrt(len(steps)) if sd else 0.0,
                     ex_open=d * exo * 100,
                     rvol_day=cv[m] / med_cum if med_cum else None,
                     rvol_15=(cv[m] - cv[m - 15]) / med_15 if med_15 else None,
                     at_ext=rp >= 0.9,
                     prev_out=(c[m] > phi) if d > 0 else (c[m] < plo),
                     new_ext15=m - ext_at[d][m] <= 15)
            if m + 60 < 390 and c[m + 60] and spy[m + 60]:
                r["f60"] = d * xr(c[m], c[m + 60], spy[m], spy[m + 60]) * 1e4
                r["raw60"] = d * (c[m + 60] / c[m] - 1) * 1e4
            if c[389] and spy[389]: r["f_close"] = d * xr(c[m], c[389], spy[m], spy[389]) * 1e4
            if m == 375 and nb and sn and c[389] and spy[389]:
                r["f_gap"] = d * xr(c[389], nb[0][1], spy[389], sn[0][1]) * 1e4
                r["raw_gap"] = d * (nb[0][1] / c[389] - 1) * 1e4
            out.append(r)
    return out


GROUPS = [
    ("All samples", lambda r: True),
    ("Strong (consistency t >= 2)", lambda r: r["strength"] >= 2),
    ("Strong + day volume >= 1.5x", lambda r: r["strength"] >= 2 and (r["rvol_day"] or 0) >= 1.5),
    ("Strong + last-15-min volume >= 3x", lambda r: r["strength"] >= 2 and (r["rvol_15"] or 0) >= 3),
    ("Strong + day vol >= 1.5x + at day extreme", lambda r: r["strength"] >= 2 and (r["rvol_day"] or 0) >= 1.5 and r["at_ext"]),
    ("  ... + beyond yesterday's high/low", lambda r: r["strength"] >= 2 and (r["rvol_day"] or 0) >= 1.5 and r["at_ext"] and r["prev_out"]),
    ("  ... + new extreme in last 15 min", lambda r: r["strength"] >= 2 and (r["rvol_day"] or 0) >= 1.5 and r["at_ext"] and r["prev_out"] and r["new_ext15"]),
    ("  ... + last-15-min volume >= 3x", lambda r: r["strength"] >= 2 and (r["rvol_day"] or 0) >= 1.5 and r["at_ext"] and r["prev_out"] and (r["rvol_15"] or 0) >= 3),
    ("Weak strength (t < 1) + day vol >= 1.5x", lambda r: r["strength"] < 1 and (r["rvol_day"] or 0) >= 1.5),
    ("Strong + quiet day volume (< 0.8x)", lambda r: r["strength"] >= 2 and (r["rvol_day"] or 9) < 0.8),
]


def report(rows, title):
    days = len({r["date"] for r in rows})
    late = [r for r in rows if r["minute"] == 375]
    print(f"\n### {title}: {len(rows):,} samples, {days} days\n")
    print("| Group | Samples | per day | Next 60 min vs SPY bp | up | To close vs SPY bp | up | Plain 60-min move bp | 15:45 samples | Overnight gap vs SPY bp | up | Plain gap bp |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, f in GROUPS:
        g = [r for r in rows if f(r)]
        gl = [r for r in late if f(r)]
        f60 = [r["f60"] for r in g if "f60" in r]; fc = [r["f_close"] for r in g if "f_close" in r]
        raw = [r["raw60"] for r in g if "raw60" in r]
        fg = [r["f_gap"] for r in gl if "f_gap" in r]; rg = [r["raw_gap"] for r in gl if "raw_gap" in r]
        mean = lambda v: f"{st.fmean(v):+.0f}" if v else ""
        up = lambda v: f"{100 * sum(x > 0 for x in v) / len(v):.0f}%" if v else ""
        print(f"| {name} | {len(g):,} | {len(g) / days:.1f} | {mean(f60)} | {up(f60)} | {mean(fc)} | {up(fc)} | {mean(raw)} | "
              f"{len(gl):,} | {mean(fg)} | {up(fg)} | {mean(rg)} |")


def main(a, b):
    cal = calendar()
    rows = []
    for i, d in enumerate(cal):
        if a <= d <= b and i >= 21: rows += day_rows(cal, i)
    report(rows, f"{a} to {b}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
