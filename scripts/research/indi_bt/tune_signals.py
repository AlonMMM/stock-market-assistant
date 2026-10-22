"""V2: tuning the C thresholds, and letting the sector relax them. Same per-minute measures as the C signal (t-stat of
1-minute moves vs SPY x beta, day volume vs the 20-session median), 09:40-15:44, one signal per stock per day.

  grid      t >= 1.7 / 1.8 / 1.9 / 2.0 with day volume >= 1.2 / 1.3 / 1.4 / 1.5 / 1.7
  sector    the stock's sector ETF (sector_filter.ETF_OF) is 0.3% or more our way since yesterday's close at that minute:
            secA  then t >= 1.5 and volume >= 1.2 are enough (V1 otherwise)
            secB  then t >= 1.7 and volume >= 1.3 are enough (V1 otherwise)
            secC  as secA, and no signal at all while the sector is 0.5% or more against us

  python3 tune_signals.py      (from the repo root, BT_UNIVERSE=wide or fav) -> data/local/x/bt/s<tag>_sig_<rule>_<year>.csv
"""
import csv, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta
from sector_filter import ETF_OF

B = "data/local/x/bt"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
TAG = os.environ.get("BT_TAG", "")
FIRST, LAST, MIN_STEPS = 10, 374, 10
RULES = {}
for tt in (1.7, 1.8, 1.9, 2.0):
    for rr in (1.2, 1.3, 1.4, 1.5, 1.7):
        RULES[f"t{int(tt * 10)}r{int(rr * 10)}"] = (tt, rr, None)
RULES["secA"] = (2.0, 1.5, (1.5, 1.2, None))
RULES["secB"] = (2.0, 1.5, (1.7, 1.3, None))
RULES["secC"] = (2.0, 1.5, (1.5, 1.2, -0.5))
if os.environ.get("BT_RULES"): RULES = {k: RULES[k] for k in os.environ["BT_RULES"].split(",")}


def passes(rule, t, rv, sec):
    """sec: the sector ETF's move our way since yesterday's close, % (None when unknown)."""
    tt, rr, relax = rule
    if relax:
        lt, lr, block = relax
        if block is not None and sec is not None and sec <= block: return False
        if sec is not None and sec >= 0.3: return t >= lt and rv >= lr
    return t >= tt and rv >= rr


def stock(sym):
    cal = calendar(); out = {k: [] for k in RULES}
    etf = ETF_OF.get(sym)
    for i, date in enumerate(cal):
        if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
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
        ec, epc = None, None
        if etf:
            eb, epb = day(etf, date), day(etf, cal[i - 1])
            if eb and epb: ec, epc = series(eb)[0], epb[-1][4]
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
            em = (ec[m] / epc - 1) * 100 if ec and epc and ec[m] else None
            for name in list(left):
                if passes(RULES[name], t, rv, em): side, sec = "C", em
                elif passes(RULES[name], -t, rv, -em if em is not None else None): side, sec = "P", -em if em is not None else None
                else: continue
                left.discard(name)
                out[name].append(dict(date=date, sym=sym, right=side, minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}",
                                      price=c[m], b_minute="", a_minute="", c_t=round(abs(t), 2), c_rvol=round(rv, 2),
                                      sector=round(sec, 2) if sec is not None else ""))
            if not left: break
    return out


def main():
    with mp.Pool(8) as pool: parts = pool.map(stock, P["universe"])
    for name in RULES:
        rows = sorted((r for p in parts for r in p[name]), key=lambda r: (r["date"], r["sym"]))
        for y in SPAN:
            ys = [r for r in rows if r["date"][:4] == y]
            with open(f"{B}/s{TAG}_sig_{name}_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(ys[0])); w.writeheader(); w.writerows(ys)
        print(name, len(rows), flush=True)


if __name__ == "__main__":
    main()
