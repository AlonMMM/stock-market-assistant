"""Entry rules taken from his two intraday setups (his_profile clusters), one trade per stock-day.

  pause    early trend pause, 9:40-10:30: gap >= +0.3% his way, up 0.5-3% since the open, at >= 0.9 of the
           day range, above VWAP, day volume >= 1.2x normal, steadiness t >= 1 (1-minute excess moves vs
           SPY x beta), last 15 minutes within +-0.5%, 5-15 minutes since the last day high
  bigmove  big mover, 11:00-14:00: up >= 5% since the open, day volume >= 2x normal, above VWAP

The direction is the day's move so far (up -> call, down -> put). The first qualifying minute is the signal.
Thresholds are round numbers read off his cluster medians (all years), so 2024-2026 is not a clean
out-of-sample test for them.

  python3 setups.py <first date> <last date> <pause|bigmove> <out.csv>     (from the repo root)
"""
import csv, math, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta

RULES = {
    "pause": dict(first=10, last=60, gap=0.3, mv_lo=0.5, mv_hi=3.0, range_pos=0.9, rvol=1.2, t=1.0, quiet15=0.5, since_lo=5, since_hi=15),
    "bigmove": dict(first=90, last=270, mv_lo=5.0, rvol=2.0),
}


def scan(sym, date, i0, cal, R, mode):
    bars = day(sym, date)
    if len(bars) < 300 or i0 < 21: return None
    c, h, l, v = series(bars)
    spy = series(day("SPY", date))[0]
    pb = day(sym, cal[i0 - 1])
    if not pb or not spy[0] or bars[0][0] > 5: return None
    o, pc = bars[0][1], pb[-1][4]
    bt = beta(sym, date, i0, cal)
    if bt is None: return None
    hist = []
    for d in cal[i0 - 20:i0]:
        vv = [0] * 390
        for b in day(sym, d): vv[b[0]] = b[5]
        cc, t_ = [0] * 390, 0
        for m in range(390): t_ += vv[m]; cc[m] = t_
        if cc[-1] > 0: hist.append(cc)
    if len(hist) < 10: return None
    for bet in (1, -1):
        hi, lo, last_ext, pv, vsum, cum, s1, s2, n = -1e18, 1e18, 0, 0.0, 0.0, 0, 0.0, 0.0, 0
        prev_c = None
        for m in range(R["last"] + 1):
            x = c[m]
            cum += v[m]
            if x is None: continue
            pv += (h[m] + l[m] + x) / 3 * v[m]; vsum += v[m]
            if (x > hi if bet > 0 else x < lo): last_ext = m
            hi, lo = max(hi, h[m]), min(lo, l[m])
            if prev_c is not None and spy[m] and spy[m - 1]:
                e = bet * ((x / prev_c - 1) - bt * (spy[m] / spy[m - 1] - 1)); s1 += e; s2 += e * e; n += 1
            prev_c = x
            if m < R["first"]: continue
            mv = bet * (x / o - 1) * 100
            if mv < R["mv_lo"] or (R.get("mv_hi") and mv > R["mv_hi"]): continue
            vw = pv / vsum if vsum else x
            if not (x > vw if bet > 0 else x < vw): continue
            norm = st.median(hh[m] for hh in hist)
            if not norm or cum / norm < R["rvol"]: continue
            if mode == "pause":
                if bet * (o / pc - 1) * 100 < R["gap"]: continue
                if hi <= lo: continue
                rp = (x - lo) / (hi - lo) if bet > 0 else (hi - x) / (hi - lo)
                if rp < R["range_pos"]: continue
                j = m - 15
                while j < m and c[j] is None: j += 1
                if abs(bet * (x / c[j] - 1) * 100) > R["quiet15"]: continue
                if not (R["since_lo"] <= m - last_ext <= R["since_hi"]): continue
                mean = s1 / n; sd = math.sqrt(max(s2 / n - mean * mean, 0))
                if not sd or mean / sd * math.sqrt(n) < R["t"]: continue
            return dict(date=date, sym=sym, right="C" if bet > 0 else "P", minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}",
                        price=x, move=round(mv, 2), rvol_day=round(cum / norm, 2))
    return None


def main(a, b, mode, out):
    cal = calendar(); R = RULES[mode]; rows = []
    for i, d in enumerate(cal):
        if not (a <= d <= b): continue
        for sym in P["universe"]:
            r = scan(sym, d, i, cal, R, mode)
            if r: rows.append(r)
    with open(out, "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(len(rows), mode, "signals ->", out)


if __name__ == "__main__":
    main(*sys.argv[1:5])
