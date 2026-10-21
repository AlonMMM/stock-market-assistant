"""V2: entry rules that trade strength vs SPY (t) against volume (rvol) on one score, instead of two separate bars.

Each minute from 09:40 to 15:44, per stock and day, the same t-stat and day volume ratio as the C signal (signals.py
tiers). A rule is a box (t >= a and rvol >= b) or a score: t / 2 + rvol / 1.5 >= s, with floors on both, so V1
scores 2.0 at its corner. The moving-volume rules add the last 5 minutes' volume vs the same 5 minutes of other days. The first minute a rule holds, in either direction, is its signal; one per stock per day.

  python3 score_signals.py [years...]   (from the repo root, BT_UNIVERSE=wide)
      -> data/local/x/bt/s_sig_<rule>_<year>.csv, the tiers.py signal format
"""
import csv, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta

B = "data/local/x/bt"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
FIRST, LAST, MIN_STEPS = 10, 374, 10


def box(a, b): return lambda t, r, r5: t >= a and r >= b


def score(s, t_floor=1.5, r_floor=1.0): return lambda t, r, r5: t >= t_floor and r >= r_floor and t / 2 + r / 1.5 >= s


# Moving volume (r5: the last 5 minutes' volume / the median of the same 5 minutes over the prior 20 sessions).
def blend(s, t_floor=1.5, r_floor=1.0):
    """The volume part is half day volume, half the last 5 minutes (3x counts like 1.5x for the day)."""
    return lambda t, r, r5: t >= t_floor and r >= r_floor and t / 2 + (r / 1.5 + r5 / 3) / 2 >= s


def boost(s, t_floor=1.5, r_floor=1.0):
    """Day volume counts 50% more while it speeds up (the last 5 minutes at 2x the day's ratio or more)."""
    return lambda t, r, r5: t >= t_floor and r >= r_floor and t / 2 + r / 1.5 * (1.5 if r5 >= 2 * r else 1.0) >= s


def burst(a, b, b5):
    """A box where a 5-minute burst can stand in for the day's volume."""
    return lambda t, r, r5: t >= a and (r >= b or r5 >= b5)


RULES = {
    "v1": box(2.0, 1.5),            # V1: both bars
    "t3r1": box(3.0, 1.0),          # the user's example: strong t, normal volume
    "t25r12": box(2.5, 1.2),
    "t15r25": box(1.5, 2.5),        # heavy volume, weaker t
    "s20": score(2.0),              # the score at V1's level, floors t 1.5 / rvol 1.0
    "s25": score(2.5),
    "s30": score(3.0),
    "m20": blend(2.0),
    "m25": blend(2.5),
    "b20": boost(2.0),
    "b25": boost(2.5),
    "t2or5x3": burst(2.0, 1.5, 3.0),    # V1, or t >= 2 with a 3x 5-minute burst
}
if os.environ.get("BT_RULES"): RULES = {k: RULES[k] for k in os.environ["BT_RULES"].split(",")}


def stock(sym):
    cal = calendar(); out = {k: [] for k in RULES}
    spans = [SPAN[y] for y in YEARS]
    for i, date in enumerate(cal):
        if not any(a <= date <= b for a, b in spans) or i < 21: continue
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
        c = series(bars)[0]; spy = series(day("SPY", date))[0]
        vol = [0] * 390
        for x in bars: vol[x[0]] = x[5]
        cum, acc = [], 0
        for x in vol: acc += x; cum.append(acc)
        n = s1 = s2 = 0.0
        left = set(RULES)
        for m in range(1, LAST + 1):
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                x = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
                n += 1; s1 += x; s2 += x * x
            if m < FIRST or n < MIN_STEPS or c[m] is None: continue
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
            med = sorted(h[m] for h in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            rv = cum[m] / usual if usual else 0.0
            med5 = sorted(h[m] - h[m - 5] for h in hist)
            usual5 = med5[k] if len(med5) % 2 else (med5[k - 1] + med5[k]) / 2
            rv5 = (cum[m] - cum[m - 5]) / usual5 if usual5 else 0.0
            for name in list(left):
                if RULES[name](t, rv, rv5): side = "C"
                elif RULES[name](-t, rv, rv5): side = "P"
                else: continue
                left.discard(name)
                out[name].append(dict(date=date, sym=sym, right=side, minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}",
                                      price=c[m], b_minute="", a_minute="", c_t=round(abs(t), 2), c_rvol=round(rv, 2), c_rvol5=round(rv5, 2)))
            if not left: break
    return out


YEARS = sys.argv[1:] or list(SPAN)


def main():
    with mp.Pool(8) as pool:
        parts = pool.map(stock, P["universe"])
    for name in RULES:
        rows = sorted((r for p in parts for r in p[name]), key=lambda r: (r["date"], r["sym"]))
        for y in YEARS:
            ys = [r for r in rows if r["date"][:4] == y]
            with open(f"{B}/s_sig_{name}_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(ys[0])); w.writeheader(); w.writerows(ys)
            print(name, y, len(ys), flush=True)


if __name__ == "__main__":
    main()
