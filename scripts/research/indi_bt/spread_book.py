"""The real book at every fill of the Bot vs Indi benchmark (the user, 2026-10-31: "for the bot vs indi dashboard - add
spread, but at, sell at, middle price to the trade table please"). For each (contract, day, minute) where a published trade
buys or sells (every paths file and every fill-price file), the Databento bid and ask the fill is priced on (real_bench:
the book at the end of the minute before the fill, at most 5 minutes old) -> <out>/fill_book.csv: contract, day, minute,
bid, ask. Every quote cache is read (fair, Favorites, the extra fetches).

  node --env-file=.env <dir>/run.mjs spread_book.py <dir with the downloaded csvs> <out>
"""
import csv, glob, gzip, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
csv.field_size_limit(1 << 30)
import real_bench as RB
import fill_models as fm

DIRS = sorted({RB.DBX, fm.DBX["fair"], fm.DBX["fav"]} | {d for d in glob.glob(os.path.join(HERE, "dbx_cache", "*")) if os.path.isdir(d)})


def book(date):
    if date not in RB.Q:
        if len(RB.Q) > 3: RB.Q.clear()
        by = {}
        for d in DIRS:
            path = os.path.join(d, f"{date}.csv.gz")
            if not os.path.exists(path): continue
            got = {}
            R = csv.DictReader(gzip.open(path, "rt"))
            if not {"contract", "minute", "bid", "ask"} <= set(R.fieldnames or []): continue
            for r in R:
                if r["bid"] and r["ask"] and float(r["ask"]) > 0 and float(r["bid"]) > 0:
                    got.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
            for k, v in got.items(): by.setdefault(k, sorted(v))
        RB.Q[date] = by
    return RB.Q[date]


RB.book = book


def day_job(job):
    date, wants = job
    out = []
    for c, m in wants:
        q = RB.quote(c, date, max(m - 1, 0))
        if q: out.append((c, date, m, q[0], q[1]))
    return out


def main():
    src, out = sys.argv[1], sys.argv[2]
    contract = {}
    for f in glob.glob(f"{src}/*.csv"):
        R = csv.DictReader(open(f))
        if "contract" in R.fieldnames:
            for r in R: contract[r["key"]] = r["contract"]
    want = {}
    for f in glob.glob(f"{src}/*.csv"):
        R = csv.DictReader(open(f))
        if "steps" not in R.fieldnames and "buy_m" not in R.fieldnames: continue
        for r in R:
            k = r["key"]
            c = contract.get(k) or contract.get(k.split("~")[0])
            if not c: continue
            if "buy_m" in R.fieldnames:
                want.setdefault(k[k.index("-20") + 1:k.index("-20") + 11], set()).add((c, int(r["buy_m"])))
                continue
            for s in r["steps"].split(";"):
                p = s.split(",")
                if len(p) >= 5 and p[2] in ("buy", "sell"): want.setdefault(p[0], set()).add((c, int(p[1])))
    print(len(contract), "keys,", sum(map(len, want.values())), "fills on", len(want), "days", flush=True)
    with mp.Pool(8) as pool: R = [x for y in pool.map(day_job, sorted((d, sorted(v)) for d, v in want.items()), chunksize=4) for x in y]
    with open(out, "w") as f:
        w = csv.writer(f); w.writerow(["contract", "day", "minute", "bid", "ask"]); w.writerows(R)
    print(len(R), "fills on the book ->", out, os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    main()
