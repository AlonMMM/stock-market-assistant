"""How many more Volume alerts a same-week expiry adds (2-4 DTE, never past the alert week's last trading day), before
any quote download: per top-50 name and day, the days with no 0/1 DTE but an expiry later that week; their alerts, and
how many have a burst (the alert minute's close against the close 3 minutes before, in S30) of 1.1+ either way.
  python3 week_count.py   (from the app repo root)"""
import datetime as dt, json, multiprocessing as mp, os
os.environ.setdefault("BT_VARIANT", "v2")
import leg_1dte as L1
import leg_twice as TW
import sim
from levels import ctx
from rvol_alert import alerts_for
from store import day
from zero5 import FIRST, LAST

HERE = os.path.dirname(os.path.abspath(__file__))
FROM = "2024-02-01"
CAL = TW.CAL
LABEL = {"0": "0 DTE", "1": "1 DTE", "w": "2-4 DTE, same week"}


def week_end(date):
    """The last trading day of the date's week."""
    d = dt.date.fromisoformat(date)
    fri = (d + dt.timedelta(days=4 - d.weekday())).isoformat()
    return max(c for c in CAL if date <= c <= fri)


def week_expiry(sym, date):
    """The nearest expiry from the date to the last trading day of its week, or None."""
    sim.C.update(dte_min=0, dte_max=(dt.date.fromisoformat(week_end(date)) - dt.date.fromisoformat(date)).days)
    e = sim.expiry_for(sym, date)
    return e if e and e <= week_end(date) else None


def kind(job):
    sym, date = job
    k = L1.kind_of(sym, date)
    if k: return k
    return "w" if week_expiry(sym, date) else None


def count(job):
    sym, date = job
    k = kind((sym, date))
    if not k: return None
    al = alerts_for(sym, date, CAL)
    x = ctx(sym, date)
    if not al or not x or not x.get("sd"): return (k, date[:4], 0, 0)
    sb = {b[0]: b for b in day(sym, date)}
    ev = [q for q in range(FIRST, LAST + 1) if al[q] and not al[q - 1] and q in sb]
    strong = sum(1 for q in ev if q - 3 in sb and abs(sb[q][4] / sb[q - 3][4] - 1) / x["sd"] >= 1.1)
    return (k, date[:4], len(ev), strong)


def main():
    top = json.load(open(os.path.join(HERE, "strangle_rank.json")))[:50]
    jobs = [(s, d) for s in top for i, d in enumerate(CAL) if d >= FROM and i >= 21]
    with mp.Pool(8) as pool: res = [r for r in pool.map(count, jobs, chunksize=16) if r]
    tab = {}
    for k, y, n, s in res:
        t = tab.setdefault((k, y), [0, 0, 0]); t[0] += 1; t[1] += n; t[2] += s
    print("| Expiry | Year | Stock-days | Alerts | Burst >= 1.1 either way |\n|---|---|---|---|---|")
    for (k, y), (d, n, s) in sorted(tab.items()):
        print(f"| {LABEL[k]} | {y} | {d:,} | {n:,} | {s:,} |")
    for k in ("0", "1", "w"):
        d, n, s = (sum(v[i] for (kk, _), v in tab.items() if kk == k) for i in range(3))
        print(f"total {k}: stock-days {d:,}, alerts {n:,}, burst {s:,}")


if __name__ == "__main__": main()
