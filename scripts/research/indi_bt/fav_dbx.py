"""Real quotes for the user's Favorites (the user, 2026-10-26: "this is the fair list or my favorites?" -> "yes", run the
real-quote check on the Favorites too). The 68 Favorites, 2025-10-23 to 2026-10-23, the lists.py runs fav68_24 (2.4's
entry) and fav68_25 (2.5's): every strike the picker scans at each signal (the fallbacks pick among them), from the
signal minute to the close, then every session after it up to the expiry (as indi_dbx_list.py).
  fav_dbx.py list    -> fav_dbx_list.csv (date, contract, minute)
  fav_dbx.py cost    Databento's price for the download (metadata.get_cost), nothing downloaded
  fav_dbx.py fetch   -> dbx_cache/fav/<date>.csv.gz and oi/ (dbx_fetch.py's fetch, to the close)
  node --env-file=.env <dir>/run.mjs fav_dbx.py <mode>      (from the app repo root; needs DATABENTO_API_KEY)
"""
import collections, csv, json, multiprocessing as mp, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import cheap_up as cu
from store import calendar

B = "data/local/x/bt"
# another period (the user, 2026-10-27: "6 12 24 months"): FAV_A / FAV_Z / FAV_LISTS / FAV_OUT_LIST
A, Z = os.environ.get("FAV_A", "2025-10-23"), os.environ.get("FAV_Z", "2026-10-23")
LISTS = tuple(os.environ.get("FAV_LISTS", "fav68_24,fav68_25").split(","))
OUT_LIST = os.path.join(HERE, os.environ.get("FAV_OUT_LIST", "fav_dbx_list.csv"))
CAL = calendar()
STATUS = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}


def one(t):
    m, date = int(t["minute"]), t["date"]
    out = []
    for c in cu.candidates(t["sym"], date, m, t["right"], float(t["price"])):
        out.append((date, c[0], m))
        for d in CAL[CAL.index(date) + 1:]:
            if d > c[1]: break
            out.append((d, c[0], 0))
    return out


def build():
    sig = {}
    for name in LISTS:
        for r in json.load(open(f"{B}/list_{name}_{A}_{Z}.json")):
            if STATUS.get(r["status"]): sig[(r["date"], r["sym"], str(r["minute"]), r["right"])] = dict(r, minute=str(r["minute"]))
    with mp.Pool(8) as pool: res = pool.map(one, list(sig.values()), chunksize=8)
    best = {}
    for date, c, m in (x for rs in res for x in rs): best[(date, c)] = min(m, best.get((date, c), 999))
    with open(OUT_LIST, "w") as f:
        w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(sorted((d, c, m) for (d, c), m in best.items()))
    print(len(sig), "signals,", len(best), "contract-days on", len({d for d, _ in best}), "days")


def days():
    by, first = collections.defaultdict(set), {}
    for r in csv.DictReader(open(OUT_LIST)):
        by[r["date"]].add(r["contract"]); first[r["date"]] = min(first.get(r["date"], 999), int(r["minute"]))
    return by, first


def cost():
    import dbx_fetch as F
    by, first = days()

    def price(d):
        total = 0.0
        syms = sorted(by[d])
        for i in range(0, len(syms), 2000):
            for schema, start, end in (("cbbo-1m", F.utc(d, first[d] - 1), F.utc(d, 391)), ("statistics", f"{d}T00:00", F.utc(d, 0))):
                data = urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", schema=schema, stype_in="raw_symbol",
                    symbols=",".join(F.pad(s) for s in syms[i:i + 2000]), start=start, end=end)).encode()
                req = urllib.request.Request("https://hist.databento.com/v0/metadata.get_cost", data=data, headers={"Authorization": F.AUTH})
                for tries in range(6):   # a busy server (504): wait and ask again
                    try:
                        total += float(urllib.request.urlopen(req, timeout=300).read().decode())
                        break
                    except Exception as e:
                        if tries == 5: raise
                        time.sleep(15 * (tries + 1))
        return total
    with ThreadPoolExecutor(3) as ex: costs = list(ex.map(price, sorted(by)))
    print(f"{len(by)} days, {sum(len(v) for v in by.values())} contract-days: ${sum(costs):,.2f} on Databento")


def fetch():
    import dbx_fetch as F
    F.OUT = os.path.join(HERE, "dbx_cache", "fav")
    F.END = 391
    by, first = days()
    ds = sorted(by, reverse=True)
    with ThreadPoolExecutor(10) as ex:
        for n, (d, rows) in enumerate(zip(ds, ex.map(lambda d: F.fetch(d, by[d], first[d]), ds)), 1):
            print(f"{n}/{len(ds)} {d} {rows} rows", flush=True)


if __name__ == "__main__":
    {"list": build, "cost": cost, "fetch": fetch}[sys.argv[1]]()
