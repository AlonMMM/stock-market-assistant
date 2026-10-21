"""V2: 0DTE entries. The C condition (t-stat vs SPY x beta, day volume vs normal), from 09:40 to 12:30 New York
(19:30 Israel most of the year), optionally only at a breakout: the stock closes at a new high of the day (a new low
for a put) at the signal minute, after the first 15 minutes. One per stock per day, the side that comes first.
The 0DTE contract itself is picked by sim.py (dte 0); days with no expiry for the stock give no trade.

  python3 zero_signals.py      (from the repo root, BT_UNIVERSE=wide) -> data/local/x/bt/z_sig_<rule>_<year>.csv
"""
import csv, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta

B = "data/local/x/bt"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
FIRST, LAST, MIN_STEPS = 10, 180, 10
RULES = {  # name -> (t, day volume ratio, breakout needed)
    "v1": (2.0, 1.5, False),
    "low": (1.5, 1.2, False),
    "v1_bo": (2.0, 1.5, True),
    "low_bo": (1.5, 1.2, True),
}


def stock(sym):
    cal = calendar(); out = {k: [] for k in RULES}
    for i, date in enumerate(cal):
        if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
        if __import__("datetime").date.fromisoformat(date).weekday() not in (0, 2, 4): continue  # weekly expiries: Mon / Wed / Fri
        bars = day(sym, date)
        if len(bars) <= 300: continue
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
        n = s1 = s2 = 0.0
        hi, lo = -1e18, 1e18
        left = set(RULES)
        for m in range(1, LAST + 1):
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                x = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
                n += 1; s1 += x; s2 += x * x
            prev_hi, prev_lo = hi, lo
            if h[m - 1]: hi = max(hi, h[m - 1])
            if l[m - 1]: lo = min(lo, l[m - 1])
            if m < FIRST or n < MIN_STEPS or c[m] is None: continue
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
            med = sorted(x[m] for x in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            rv = cum[m] / usual if usual else 0.0
            up_bo = m >= 15 and c[m] > hi
            down_bo = m >= 15 and c[m] < lo
            for name in list(left):
                tt, rr, bo = RULES[name]
                if rv < rr: continue
                if t >= tt and (not bo or up_bo): side = "C"
                elif -t >= tt and (not bo or down_bo): side = "P"
                else: continue
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
            with open(f"{B}/z_sig_{name}_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(ys[0])); w.writeheader(); w.writerows(ys)
            print(name, y, len(ys), flush=True)


if __name__ == "__main__":
    main()
