"""The benchmark's trades under other fill prices, for the Bot vs Indi dashboard's fill toggle (the user, 2026-10-27: "Add
to bot vs indi a toggle for +-2 +-5 +-10 avg price from spread. And real one."). Every trade of export_bench.py (the fair
list) and fav_bench.py export (the Favorites, fav12: / fav6: keys), each version and each @fb one:
  f2    as on the page: each buy at the option bar's middle + 2%, each sale at the middle - 2% (sim.py spread_half)
  f5    the same walk with 5% each way (the stops and takes read the gain on what was paid, so exits can move)
  f10   10% each way
  real  the f2 walk priced on the Databento book (opt_spread.price "bid": a buy at the mid + half the way to the ask,
        paying the next ask, at most +10%, when the next minute's bid is above it; a sale at the bid; the book at the
        end of the minute before the fill bar, real_bench.quote). A fill with no quote keeps its f2 price; `cov` is the
        share of the trade's buys and sales priced on the book (the cache: fair list to 2026-10-16, the Favorites' own)
$0.62 a contract each way and the 10% overnight cap at each size, as everywhere.

  node --env-file=.env <dir>/run.mjs fill_models.py <out dir>      (from the app repo root)
-> <out>/fills_f5.csv, fills_f10.csv, fills_real.csv: key, cost, ret at 1% / 2% / 4% / 5%, exit, overnight, steps (, cov)
"""
import csv, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import fav_bench as fb
import opt_spread as OS
import real_bench as RB

CAL = eb.CAL
SIZES = (0.01, 0.02, 0.04, 0.05)
DBX = {"fair": os.path.join(HERE, "dbx_cache", "indi"), "fav": os.path.join(HERE, "dbx_cache", "fav")}


def rets(cost, steps):
    r = {("ret" if s == 0.01 else f"ret_{round(s * 100)}pct"): round(sim.result(cost, steps, s), 4) for s in SIZES}
    last = [s for s in steps if s[2] == "sell"][-1]
    return dict(cost=round(cost, 4), **r, exit=eb.words(steps), overnight=int(last[0] != steps[0][0]),
                steps=";".join(f"{s[0]},{s[1]},{s[2]},{s[3]},{s[4]},{s[5]}" for s in steps))


def one(job):
    src, slug, t = job
    if RB.DBX != DBX[src]: RB.DBX = DBX[src]; RB.Q.clear(); RB.OI.clear()  # spawned workers start on the fair list's cache
    _, _, exits, fallback = eb.VERSIONS[slug]
    p = eb.contract(t, fallback)
    if not p: return None
    m0 = int(t["minute"])
    out = dict(key=f"{slug}-{t['date']}-{t['sym']}-{t['right']}-{m0}", date=t["date"])
    sim.X.clear(); sim.X.update(exits)
    for model, sh in (("f5", 0.05), ("f10", 0.10), ("f2", 0.02)):
        sim.SH = sh
        cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], p[0], p[1], CAL)
        if cost is None: return None
        if model != "f2": out[model] = rets(cost, steps)
    rcost, real = OS.price(steps, p[0], cost, "bid")
    fills = [s for s in steps if s[2] in ("buy", "sell")]
    quoted = sum(bool(RB.quote(p[0], s[0], max(s[1] - 1, 0))) for s in fills)
    out["real"] = dict(rets(rcost, real), cov=round(quoted / len(fills), 2))
    return out


def run(jobs):
    with mp.Pool(8) as pool: return [r for r in pool.map(one, jobs, chunksize=8) if r]


def main():
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    S = fb.signals()
    rows = {"f5": [], "f10": [], "real": []}
    for src in ("fair", "fav"):
        jobs = [(src, slug, t) for slug, v in eb.VERSIONS.items() for t in S[(src, v[1])] if t["status"] == "ok" or v[3]]
        R = run(jobs)
        print(src, len(jobs), "jobs,", len(R), "trades", flush=True)
        for r in R:
            keys = [r["key"]]
            if src == "fav": keys = [f"{pre}:{r['key']}" for pre, a in (("fav12", fb.A12), ("fav6", fb.A6)) if r["date"] >= a]
            for k in keys:
                for model in rows: rows[model].append(dict(key=k, **r[model]))
    for model, data in rows.items():
        with open(f"{out}/fills_{model}.csv", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys())); w.writeheader(); w.writerows(data)
        print(f"fills_{model}.csv", len(data), "rows", os.path.getsize(f"{out}/fills_{model}.csv") // 1024, "KB", flush=True)
    cov = [float(r["cov"]) for r in rows["real"]]
    print("real: trades with every fill on the book", round(sum(c == 1 for c in cov) / len(cov), 3), "none", round(sum(c == 0 for c in cov) / len(cov), 3))


if __name__ == "__main__":
    main()
