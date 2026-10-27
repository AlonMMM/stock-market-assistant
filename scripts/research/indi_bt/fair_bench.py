"""The fair-price buy on the Bot vs Indi benchmark (the user, 2026-10-27: "show me the fair price in the benchmark as
well"): every benchmark trade on real quotes (fill_models.py / export_champ.py fills_real) with its buys placed as
fair_fill.py's winner: a limit at the size-weighted microprice + 3 ticks, never above the usual price (the mid + half
the way to the ask), 1 minute, filled when the option prints at or below it or the ask comes down to it; else the
usual price on the book at the end of that minute, with the runaway rule (the next minute's ask, at most +10%). The
sales stay at the bid. A buy with no quote keeps its real price.

  python3 <dir>/fair_bench.py <dir with all_trades.csv and fills_real.csv>      (from the app repo root)
-> <dir>/fills_fair.csv: key, buy minute, buy price, ret at 1% / 2% / 4% / 5% (the rest of the trade is fills_real's)
"""
import csv, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import fair_fill as ff
import fill_models as fm
import real_bench as RB
from store import day

csv.field_size_limit(10 ** 9)
SIZES = (0.01, 0.02, 0.04, 0.05)


def parse(steps):
    out = []
    for x in steps.split(";"):
        d, m, side, q, px, rule = x.split(",")
        out.append((d, int(m), side, float(q), float(px), rule))
    return out


def price(job):
    """-> the fills_fair row of one trade."""
    src, key, date, c, cost, steps = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear()
    buy = steps[0]
    m = buy[1]
    paid = cost
    q = ff.quote_sz(c, date, m - 1)
    first_sale = min((s[1] for s in steps if s[2] == "sell" and s[0] == date), default=999)
    if q and q[2] + q[3] > 0:
        bid, ask, bs_, as_ = q
        micro = (bid * as_ + ask * bs_) / (bs_ + as_)
        limit = min(micro + 3 * ff.tick(micro), ff.usual(q))
        bars = {b[0]: b for b in day(c, date)}
        now = ff.quote_sz(c, date, m)
        filled = m < first_sale and ((m in bars and bars[m][3] <= limit + 1e-9) or (now and now[1] <= limit + 1e-9))
        if filled: paid = limit
        elif now:
            paid = ff.usual(now)
            nxt = ff.quote_sz(c, date, m + 1)
            if nxt and nxt[0] > paid: paid = min(nxt[1], paid * 1.1)
            m += 1
    paid = round(paid, 4)
    new = [(date, m, "buy", 1.0, paid, buy[5])] + steps[1:]
    k = 0.5 if key.endswith("+add") else 1.0
    r = {("ret" if s == 0.01 else f"ret_{round(s * 100)}pct"): round(k * sim.result(paid, new, s * k), 4) for s in SIZES}
    return dict(key=key, buy_m=m, buy_px=paid, **r)


def main():
    d = sys.argv[1]
    T = {r["key"]: r for r in csv.DictReader(open(f"{d}/all_trades.csv"))}
    jobs = []
    for f in csv.DictReader(open(f"{d}/fills_real.csv")):
        t = T.get(f["key"])
        if not t: continue
        src = "fav" if ":" in t["version"] else "fair"
        jobs.append((src, f["key"], t["date"], t["contract"], float(f["cost"]), parse(f["steps"])))
    jobs.sort(key=lambda j: (j[0], j[2]))   # a day's quotes are read once a worker
    with mp.Pool(8) as pool: R = pool.map(price, jobs, chunksize=64)
    with open(f"{d}/fills_fair.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(R[0])); w.writeheader(); w.writerows(R)
    print(len(R), "trades ->", f"{d}/fills_fair.csv", os.path.getsize(f"{d}/fills_fair.csv") // 1024, "KB")


if __name__ == "__main__":
    main()
