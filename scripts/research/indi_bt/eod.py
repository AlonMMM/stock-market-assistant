"""End-of-day entry held overnight, from his last-20-minute entries (43% of his real P&L, positive every year).

At 15:46 (minute 376), for each stock, in the day's direction: up >= +2% from yesterday's close, in the top
20% of the day's range, beyond yesterday's high (low for a put), not a Friday. One per stock-day; `score`
= the move vs SPY x beta since yesterday's close, to rank the day's signals.

  python3 eod.py <first date> <last date> <out.csv> [hold]      (from the repo root)

hold: his "doesn't want to go down" setup instead. Up 1-5% from yesterday's close in the day's direction, the
5-day trend the same way, never more than 1% under its running high (low for a put) since 13:00, at >= 0.7 of
the day range, not a Friday; the top 2 a day by the move vs SPY x beta.
"""
import csv, datetime as dt, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta

M = 376


def hold_rows(d, i, cal, spy, spb):
    out = []
    for sym in P["universe"]:
        bars = day(sym, d); pb = day(sym, cal[i - 1]); p5 = day(sym, cal[i - 6])
        if len(bars) < 300 or not pb or not p5: continue
        c, h, l, v = series(bars)
        x = next((c[m] for m in range(M, 360, -1) if c[m]), None)
        if x is None: continue
        pc = pb[-1][4]; bet = 1 if x >= pc else -1
        mv = bet * (x / pc - 1) * 100
        if not 1.0 <= mv <= 5.0 or bet * (pc / p5[-1][4] - 1) <= 0: continue
        run, worst = None, 0.0
        for m in range(M + 1):
            e = h[m] if bet > 0 else l[m]
            if e: run = e if run is None else (max(run, e) if bet > 0 else min(run, e))
            if m >= 210 and c[m] and run: worst = min(worst, bet * (c[m] / run - 1) * 100)
        if worst < -1.0: continue
        hi, lo = max(z for z in h[:M + 1] if z), min(z for z in l[:M + 1] if z)
        rp = ((x - lo) if bet > 0 else (hi - x)) / (hi - lo) if hi > lo else 0
        if rp < 0.7: continue
        bt = beta(sym, d, i, cal) or 1.0
        out.append(dict(date=d, sym=sym, right="C" if bet > 0 else "P", minute=M, time="15:46", price=x, move=round(mv, 2),
                        range_pos=round(rp, 2), giveback=round(worst, 2), score=round(mv - bt * bet * (spy[M] / spb[-1][4] - 1) * 100, 2)))
    return sorted(out, key=lambda r: -r["score"])[:2]


def main(a, b, out, mode="basic"):
    cal = calendar(); rows = []
    for i, d in enumerate(cal):
        if not (a <= d <= b) or i < 21 or dt.date.fromisoformat(d).weekday() == 4: continue
        spy = series(day("SPY", d))[0]; spb = day("SPY", cal[i - 1])
        if not spy[M] or not spb: continue
        if mode == "hold":
            rows += hold_rows(d, i, cal, spy, spb); continue
        for sym in P["universe"]:
            bars = day(sym, d); pb = day(sym, cal[i - 1])
            if len(bars) < 300 or not pb: continue
            c, h, l, v = series(bars)
            m = M
            while m > 360 and c[m] is None: m -= 1
            x = c[m]
            if x is None: continue
            pc, phi, plo = pb[-1][4], max(z[2] for z in pb), min(z[3] for z in pb)
            hi, lo = max(z for z in h[:m + 1] if z), min(z for z in l[:m + 1] if z)
            for bet in (1, -1):
                mv = bet * (x / pc - 1) * 100
                if mv < 2.0: continue
                rp = ((x - lo) if bet > 0 else (hi - x)) / (hi - lo) if hi > lo else 0
                if rp < 0.8 or not (x > phi if bet > 0 else x < plo): continue
                bt = beta(sym, d, i, cal) or 1.0
                ex = mv - bt * bet * (spy[M] / spb[-1][4] - 1) * 100
                rows.append(dict(date=d, sym=sym, right="C" if bet > 0 else "P", minute=M, time="15:46", price=x,
                                 move=round(mv, 2), range_pos=round(rp, 2), score=round(ex, 2)))
    with open(out, "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(len(rows), "end-of-day signals ->", out)


if __name__ == "__main__":
    main(*sys.argv[1:5])
