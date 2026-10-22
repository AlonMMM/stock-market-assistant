"""V2: 0DTE breakout entries in a time window (Z_WIN: early = 09:45-10:30, late = 14:30-15:30 New York), signalled on
the breakout bar itself. In the late window a "prev" breakout is a close beyond yesterday's high (low) at a new high
(low) of the day. Written by zero3_signals.py from zero2_signals.py. In the breakout's direction:
  day   the close makes a new high of the day (a new low for a put), after the first 15 minutes
  or30  the first close beyond the first 30 minutes' range
  prev  the first close beyond yesterday's high (low)
each with a confirmation on the C measures (t-stat of 1-minute moves vs SPY x beta, day volume vs normal) at that minute.
Only Mon / Wed / Fri (single-stock expiries); sim.py finds the day's 0DTE contract or skips.

  Z_WIN=early|late python3 zero3_signals.py      (from the repo root, BT_UNIVERSE=wide) -> data/local/x/bt/z3_sig_<rule>_<win>_<year>.csv
"""
import csv, datetime as dt, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta

B = "data/local/x/bt"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
WIN = os.environ.get("Z_WIN", "early")
FIRST, LAST = {"early": (15, 60), "late": (300, 360)}[WIN]
RULES = {  # name -> (breakout kind, t needed, day volume ratio needed)
    "E1": ("day", 1.5, 1.2),
    "E2": ("day", 2.0, 1.5),
    "E5": ("prev", 1.0, 1.2),
    "E6": ("prev", 0.0, 1.5),
}


def stock(sym):
    cal = calendar(); out = {k: [] for k in RULES}
    for i, date in enumerate(cal):
        if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
        if dt.date.fromisoformat(date).weekday() not in (0, 2, 4): continue
        bars, pb = day(sym, date), day(sym, cal[i - 1])
        if len(bars) <= 300 or not pb: continue
        b_ = beta(sym, date, i, cal)
        if b_ is None: continue
        hist = []
        for d in cal[i - 20:i]:
            v = [0] * 390
            for x in day(sym, d): v[x[0]] = x[5]
            acc, cum = 0, []
            for x in v: acc += x; cum.append(acc)
            if cum[-1] > 0: hist.append(cum)
        if len(hist) < 10: continue
        c, h, l, _ = series(bars); spy = series(day("SPY", date))[0]
        vol = [0] * 390
        for x in bars: vol[x[0]] = x[5]
        cum, acc = [], 0
        for x in vol: acc += x; cum.append(acc)
        phi, plo = max(x[2] for x in pb), min(x[3] for x in pb)
        orh = max(x for x in h[:30] if x) if any(h[:30]) else None
        orl = min(x for x in l[:30] if x) if any(l[:30]) else None
        n = s1 = s2 = 0.0
        hi, lo = -1e18, 1e18
        seen = {"or30": set(), "prev": set()}  # first close beyond: once per side
        left = set(RULES)
        for m in range(1, LAST + 1):
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                x = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
                n += 1; s1 += x; s2 += x * x
            if h[m - 1]: hi = max(hi, h[m - 1])
            if l[m - 1]: lo = min(lo, l[m - 1])
            if c[m] is None or n < 10: continue
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
            med = sorted(x[m] for x in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            rv = cum[m] / usual if usual else 0.0
            bo = {"day": {"C": c[m] > hi, "P": c[m] < lo}, "or30": {"C": False, "P": False}, "prev": {"C": False, "P": False}}
            if m >= 30 and orh:
                for side, hit in (("C", c[m] > orh), ("P", c[m] < orl)):
                    if hit and side not in seen["or30"]: seen["or30"].add(side); bo["or30"][side] = True
            for side, hit in (("C", c[m] > phi), ("P", c[m] < plo)):
                if hit and side not in seen["prev"]: seen["prev"].add(side); bo["prev"][side] = True
            if WIN == "late":  # late: beyond yesterday's level and at a new day extreme, any minute
                bo["prev"] = {"C": c[m] > phi and c[m] > hi, "P": c[m] < plo and c[m] < lo}
            if m < FIRST: continue
            for name in list(left):
                kind, tt, rr = RULES[name]
                if rv < rr: continue
                side = None
                if bo[kind]["C"] and t >= tt: side = "C"
                elif bo[kind]["P"] and -t >= tt: side = "P"
                if side is None: continue
                left.discard(name)
                out[name].append(dict(date=date, sym=sym, right=side, minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}",
                                      price=c[m], b_minute="", a_minute="", c_t=round(abs(t), 2), c_rvol=round(rv, 2)))
            if not left: break
    return out


def main():
    with mp.Pool(8) as pool: parts = pool.map(stock, P["universe"])
    for name in RULES:
        rows = sorted((r for p in parts for r in p[name]), key=lambda r: (r["date"], r["sym"]))
        for y in SPAN:
            ys = [r for r in rows if r["date"][:4] == y]
            with open(f"{B}/z3{os.environ.get('Z_TAG', '')}_sig_{name}_{WIN}_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(ys[0])); w.writeheader(); w.writerows(ys)
            print(name, y, len(ys), flush=True)


if __name__ == "__main__":
    main()
