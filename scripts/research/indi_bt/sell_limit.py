"""A limit sale at the mid for the Volume winner (the user, 2026-10-28): at the exit, offer the option at the mid for W
seconds; if it does not fill, sell at the bid then. Two fill counts: "quotes" (the bid rises to our price: certain) and
"prints" (a trade prints at our price or above: we would likely have been filled). The buy side and the exit rule stay.
  WS_IN=<leg_seconds.py STR_DUMP_ALL file> python3 sell_limit.py fetch | run     (from the app repo root)
fetch: the option's book (cbbo-1s, cmbp-1 before 2025-02-20) and its trades from 2 s before the exit second to 62 s after."""
import csv, gzip, io, json, os, sys
from concurrent.futures import ThreadPoolExecutor
os.environ.setdefault("BT_VARIANT", "v2")
import leg_seconds as LS
import leg_twice as TW
import leg_daycap as D

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sec_cache", "sell")


def trades_in():
    T = [t for t in json.load(open(os.environ["WS_IN"])) if not t["news_skip"]]
    ev = json.load(open(os.path.join(LS.OUT, f"events{LS.TAG}.json"))); pk = json.load(open(os.path.join(LS.OUT, f"picks{LS.TAG}.json")))
    C = {(e["date"], e["sym"], e["m"]): p["p"]["cross|plain20"][0] for e, p in zip(ev, pk) if "cross|plain20" in p["p"]}
    for t in T: t["contract"] = C[(t["date"], t["sym"], int(t["minute"]))]; t["t0"] = (int(t["xm"]) + 1) * 60   # the exit minute's close
    return T


def paths(t):
    base = os.path.join(OUT, f"{t['date']}_{t['contract']}_{t['t0']}")
    return base + "_book.csv.gz", base + "_trades.csv.gz"


def fetch_one(t):
    pb, pt = paths(t)
    if os.path.exists(pb) and os.path.exists(pt): return
    sym = t["contract"][:-15].ljust(6) + t["contract"][-15:]
    schema, back, shift = ("cbbo-1s", 2, 1) if t["date"] >= LS.SEC1 else ("cmbp-1", 30, 0)
    rows = [(LS.sec_of(r["ts_recv"]) - shift, r["bid_px_00"], r["ask_px_00"]) for r in csv.DictReader(io.StringIO(LS.get("OPRA.PILLAR", schema, sym, t["date"], t["t0"] - back, t["t0"] + 62)))
            if r["bid_px_00"] and r["ask_px_00"]]
    prints = [(LS.sec_of(r["ts_event"]), r["price"], r["size"]) for r in csv.DictReader(io.StringIO(LS.get("OPRA.PILLAR", "trades", sym, t["date"], t["t0"] - 2, t["t0"] + 62)))]
    os.makedirs(OUT, exist_ok=True)
    for p, data in ((pb, rows), (pt, prints)):
        with gzip.open(p + ".tmp", "wt") as f: csv.writer(f).writerows(data)
        os.replace(p + ".tmp", p)


def sale(t, wait, count):
    """The sale price with a limit at the mid for `wait` s, then the bid. -> (price, how) or None without a book."""
    pb, pt = paths(t)
    if not os.path.exists(pb): return None
    book = [(int(a), float(b), float(c)) for a, b, c in csv.reader(gzip.open(pb, "rt")) if float(b) > 0 and float(c) > 0]
    book = [r for r in book if r[2] - r[1] <= 0.5 * (r[1] + r[2]) / 2]   # drop a flickering book (spread over 50% of the mid)
    k = [r for r in book if r[0] <= t["t0"]]
    if not k: return None
    bid0, ask0 = k[-1][1], k[-1][2]
    if wait == 0: return bid0, "bid"
    lim = (bid0 + ask0) / 2
    later = [r for r in book if t["t0"] < r[0] <= t["t0"] + wait]
    if any(r[1] >= lim for r in later): return lim, "filled (quote)"
    if count == "prints":
        pr = [(int(a), float(b)) for a, b, c in csv.reader(gzip.open(pt, "rt"))] if os.path.exists(pt) else []
        if any(t["t0"] < s <= t["t0"] + wait and p >= lim for s, p in pr): return lim, "filled (print)"
    end = [r for r in book if r[0] <= t["t0"] + wait]
    return max(end[-1][1], 0.01), "bid after the wait"


def kept(T, size):
    by = {}
    for t in T: by.setdefault((t["date"], t["sym"]), []).append(dict(minute=t["minute"], trade=t))
    keep = [x["trade"] for evs in by.values() for x in TW.pick(dict(events=sorted(evs, key=lambda z: z["minute"])), "flat")[:2]]
    return D.account(keep, size, 2, loss=7.5, max_trades=15, max_open=5)


def main():
    T = trades_in()
    if sys.argv[1] == "fetch":
        with ThreadPoolExecutor(20) as ex:
            for n, _ in enumerate(ex.map(fetch_one, T)):
                if n % 50 == 0: print(n, "/", len(T), flush=True)
        return
    base = {}
    for t in T:
        s = sale(t, 0, "quotes")
        base[id(t)] = s
    have = [t for t in T if base[id(t)]]
    print(f"{len(T)} trades, {len(have)} with the exit book; the bid at the exit second vs the minute-close bid used so far: "
          f"{sum(base[id(t)][0] for t in have) / sum(float(t['sell']) for t in have) - 1:+.1%}")
    print("| Rule | Count | Filled at the mid | $100K becomes (2%) | Avg | Drop | Tune / check | Check without 2025-10-10 |")
    print("|---|---|---|---|---|---|---|---|")
    avg = lambda L: sum(L) / max(1, len(L))
    for wait, count in ((None, "-"), (0, "quotes"), (1, "quotes"), (2, "quotes"), (5, "quotes"), (10, "quotes"), (30, "quotes"), (1, "prints"), (2, "prints"), (5, "prints"), (10, "prints"), (30, "prints")):
        P, filled = [], 0
        for t in T:
            if wait is None: P.append(t); continue
            s = sale(t, wait, count)
            if not s: P.append(t); continue   # no book: the old price
            filled += s[1].startswith("filled")
            P.append(dict(t, sell=s[0]))
        end, dd, R, _, _ = kept(P, 2)
        ret = lambda r: (r["sell"] * 100 - 0.62) / (r["buy"] * 100 + 0.62) - 1
        tune, chk = avg([ret(r) for r in R if r["date"] < "2025-07"]), avg([ret(r) for r in R if r["date"] >= "2025-07"])
        chk_wo = avg([ret(r) for r in R if r["date"] >= "2025-07" and r["date"] != "2025-10-10"])
        name = "today: the minute-close bid" if wait is None else ("the bid at the exit second" if wait == 0 else f"mid for {wait} s, then the bid")
        print(f"| {name} | {count} | {filled} | ${end:,.0f} | {100 * avg([ret(r) for r in R]):+.1f}% | {100 * dd:.1f}% | {100 * tune:+.1f} / {100 * chk:+.1f} | {100 * chk_wo:+.1f} |", flush=True)


if __name__ == "__main__": main()
