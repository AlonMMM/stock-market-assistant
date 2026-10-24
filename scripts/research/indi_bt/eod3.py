"""V2: the close trade, Indi's way (the user, 2026-10-24: "don't care about volume, but I do care about the strength").
From eod1.py, changed to how Indi trades it (his 142 single-stock entries from 15:30 held overnight, 2023-26: mostly
in the top 20% of the day's range our way, options 1-3 days out, first sale in the first 30 minutes). Unlike eod2.py
(15:46, held with the champion's morning rule), one best stock a day and out in the first 30 minutes. Set before
running:

Candidates at 15:55 New York (minute 385), each stock of the list:
  strength  hour: t-stat of the 1-minute moves vs SPY x beta over 14:55-15:55; day: the same from the open (the
            champion's C measure); call when > 0, put when < 0. Versions t >= 1.0 / 1.5 / 2.0. No volume condition.
  the close in the top 20% of the day's range our way (the high for a call, the low for a put)
  the nearest expiry 1-4 calendar days out; no earnings reaction tomorrow
The best = the highest strength; when its contract fails the price / volume minimums, the next, up to 5. One trade a
day per list. Delta 0.15 / 0.20 / 0.25. Fill on the next bar (15:56-15:59) at the middle + 2%. Exits the next
session, all within the first 30 minutes (sales at the bar's middle - 2%):
  OPEN    all on the first bar
  M15     all at 09:45
  M30     all at 10:00
  TP50    all at +50% or -30% (decided on a bar's close, sold on the next bar), else all at 10:00
Lists: the fair list and the 151 unseen (2024-02 to 2026-10-12), and the user's Favorites (2025-10-23 to
2026-10-22). 1% / 2% of the start-of-day account from $100,000.

  node --env-file=.env <path>/run.mjs eod3.py      (from the repo root) -> data/local/x/bt/eod3_trades.csv
"""
import csv, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("BT_UNIVERSE", "wide")
import sim
import news_filter as nf
from store import P, day, calendar
from signals import series, beta
from levels import ctx
from score_sum import account
from eod1 import LISTS, FAV, M

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
KINDS = {"hour": 326, "day": 1}  # strength measured from this minute to 15:55
FLOORS = (1.0, 1.5, 2.0)
TOP = 0.8
DELTAS = (0.15, 0.20, 0.25)
EXITS = ("OPEN", "M15", "M30", "TP50")
SH = sim.SH
sim.C.update(dte_min=1, dte_max=4)


def tstat(c, spy, b_, m0):
    n = s1 = s2 = 0.0
    for m in range(max(1, m0), M + 1):
        if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            r = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
            n += 1; s1 += r; s2 += r * r
    if n < 20: return None
    mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
    return mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0


def stock(sym):
    """-> per day: the stock's 15:55 measures {date, sym, hour, day, pos, close}."""
    out = []
    for i, date in enumerate(CAL):
        if i < 21 or i + 1 >= len(CAL): continue
        if not any(a <= date <= b for f, (a, b) in LISTS.values()): continue
        exp = sim.expiry_for(sym, date)
        if not exp or exp <= date: continue
        x = ctx(sym, date)
        if x is None or x["c"][M] is None: continue
        b_ = beta(sym, date, i, CAL)
        if b_ is None: continue
        spy = series(day("SPY", date))[0]
        th, td = tstat(x["c"], spy, b_, KINDS["hour"]), tstat(x["c"], spy, b_, KINDS["day"])
        if th is None or td is None: continue
        hi = max(v for v in x["h"][:M + 1] if v); lo = min(v for v in x["l"][:M + 1] if v)
        pos = (x["c"][M] - lo) / (hi - lo) if hi > lo else 0.5
        out.append(dict(date=date, sym=sym, hour=th, day=td, pos=pos, close=x["c"][M]))
    return out


def exits(sym, date, con):
    """-> (cost, {exit: ret}) for one contract bought at 15:55 and sold in the next session's first 30 minutes."""
    nxt = CAL[IDX[date] + 1]
    sim.fetch_bars("options", [con], date, nxt)
    b0 = next((b for b in day(con, date) if M < b[0] <= 389), None)
    if not b0: return None, "no_fill"
    cost = sim.mid(b0) * (1 + SH)
    ob = day(con, nxt)
    if not ob: return None, "no_bars_next"
    sell = lambda b: max(sim.mid(b) * (1 - SH), 0.01)
    at = lambda m: next((b for b in ob if b[0] >= m), ob[-1])
    after = lambda m: next((b for b in ob if b[0] > m), ob[-1])
    hit = next((b for b in ob if b[0] < 30 and (b[4] >= cost * 1.5 or b[4] <= cost * 0.7)), None)
    res = {"OPEN": sell(ob[0]), "M15": sell(at(15)), "M30": sell(at(30)), "TP50": sell(after(hit[0]) if hit else at(30))}
    return cost, {k: sim.result(cost, [(nxt, 0, "sell", 1.0, p, k)]) for k, p in res.items()}


def trade(job):
    lname, date, kind, floor, d, cands = job
    sim.C.update(delta=d)
    for c in cands[:5]:
        right = "C" if c[kind] > 0 else "P"
        best, why = sim.pick(c["sym"], date, M, right, c["close"])
        if best is None: continue
        cost, res = exits(c["sym"], date, best[0])
        if cost is None: continue
        return dict(list=lname, date=date, kind=kind, floor=floor, delta=d, sym=c["sym"], right=right, t=round(c[kind], 2),
                    contract=best[0], expiry=best[1], cost=round(cost, 4), **{k: round(v, 4) for k, v in res.items()})
    return None


def main():
    syms = sorted(set(P["universe"]) | set(FAV))
    with mp.Pool(8) as pool: parts = pool.map(stock, syms)
    R = [r for p in parts for r in p]
    for r in R: r["right"] = "C" if r["day"] > 0 else "P"  # features() needs a side; earnings do not depend on it
    nf.features(R)
    R = [r for r in R if r["e_next"] != 1]
    print(len(R), "stock days with an expiry 1-4 days out", flush=True)
    jobs = []
    for lname, (lf, (A, Z)) in LISTS.items():
        by = {}
        for r in R:
            if A <= r["date"] <= Z and lf(r["sym"], r["date"]): by.setdefault(r["date"], []).append(r)
        for date, rows in sorted(by.items()):
            for kind in KINDS:
                for floor in FLOORS:
                    C = []
                    for r in rows:
                        ourway = r["pos"] if r[kind] > 0 else 1 - r["pos"]
                        if abs(r[kind]) >= floor and ourway >= TOP: C.append(r)
                    if not C: continue
                    C.sort(key=lambda r: -abs(r[kind]))
                    for d in DELTAS: jobs.append((lname, date, kind, floor, d, C))
    print(len(jobs), "list days x versions", flush=True)
    with mp.Pool(8) as pool: rows = [r for r in pool.imap(trade, jobs, chunksize=8) if r]
    with open(f"{B}/eod3_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    summary(rows)


def summary(rows=None):
    if rows is None: rows = list(csv.DictReader(open(f"{B}/eod3_trades.csv")))
    for lname in LISTS:
        print(f"\n### {lname} (trades / winners / per trade at $10K 2024 2025 2026 / account at 1% / worst drop / at 2% / without best 5)")
        for kind in KINDS:
            for floor in FLOORS:
                for d in DELTAS:
                    L = sorted((r for r in rows if r["list"] == lname and r["kind"] == kind and float(r["floor"]) == floor and float(r["delta"]) == d), key=lambda r: r["date"])
                    if not L: continue
                    for ex in EXITS:
                        pn = [dict(date=r["date"], pnl=str(1e4 * max(-1, float(r[ex])))) for r in L]
                        a1, d1 = account(pn); a2, d2 = account(pn, 0.02)
                        top = set(sorted(range(len(pn)), key=lambda k: -float(pn[k]["pnl"]))[:5])
                        a5, _ = account([p for k, p in enumerate(pn) if k not in top])
                        win = sum(float(r[ex]) > 0 for r in L) / len(L)
                        yr = " ".join(f"{st.fmean([float(p['pnl']) for p in pn if p['date'][:4] == y] or [0]):+,.0f}" for y in ("2024", "2025", "2026"))
                        print(f"{kind:4} t{floor} d{d} {ex:4} | {len(L)} / {100 * win:.0f}% / {yr} / ${a1:,.0f} / {100 * d1:.0f}% / ${a2:,.0f} / wo5 ${a5:,.0f}")


if __name__ == "__main__":
    summary() if sys.argv[1:] == ["summary"] else main()
