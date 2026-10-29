"""The champion on the Nasdaq-100, 2026 (the user, 2026-10-29: "Can we add more stocks to our test? I want to take hot
stocks, from the nasdaq 100. Atlist for 2026", then "Yes lets go").

The universe: ndx_2026.txt (the index after its 22 Dec 2025 reconstitution, GOOG out); 77 of its 100 stocks are new to
the fair list and the Favorites. Signals: lists.py run 2026-01-02 2026-10-23 ndx26 with BT_ENTRY=c12_15 (the champion's
entry, the news filter), re-walked here with the champion's pick and exits (retry_roll.py: 0.15 delta, IBIT down to
$0.10, 200 contracts). The NDX list has no pyramid add (no t >= 1.8 list was built for it). Hot (ndx_hot.py, set before
running): each month's top 20 by momentum vs QQQ or by "in play" dollar volume, from the month before only.
Versions, 2026 only, tune AND check weeks (split.py), 2% and 3% from $100,000:
  alone   NDX all · NDX new (the 77) · NDX momentum 20 · NDX in play 20; for reference the Favorites and the fair list
          in 2026 (with their pyramid)
  added   the Favorites (2026) + the new NDX stocks: all 77, or only the month's momentum / in-play names among them
Per list also the giants (+300%+), the median trade and the non-giants' sum at $10K (memory: giants-decide-buckets).
Real quotes: NT_PASS=list -> open5_dbx_list.csv, dbx_fetch.py open5 -> dbx_cache/open5; the book reads every cache.

  node --env-file=.env <dir>/run.mjs ndx_test.py (NT_PASS=list first, then dbx_fetch.py open5)   (from the app repo root)
"""
import collections, csv, gzip, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from low_delta import HIS40
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
A, Z = "2026-01-02", "2026-10-23"
LISTING = os.environ.get("NT_PASS") == "list"
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open5")]
NDX = [s for line in open(os.path.join(HERE, "ndx_2026.txt")) if not line.startswith("#") for s in line.split() if s != "GOOG"]
KNOWN = set(HIS40) | {t["sym"] for t in FR.signals("25")} | {t["sym"] for t in FR.signals("24")}
NEW = [s for s in NDX if s not in KNOWN]
HOT = json.load(open(f"{B}/ndx_hot.json")) if os.path.exists(f"{B}/ndx_hot.json") else {}


def book(date):
    """real_bench.book over the list's cache, the other list's and the extra fetches."""
    if date not in RB.Q:
        if len(RB.Q) > 3: RB.Q.clear()
        by = {}
        for d in [RB.DBX, fm.DBX["fair"], fm.DBX["fav"]] + EXTRAS:
            path = os.path.join(d, f"{date}.csv.gz")
            if not os.path.exists(path): continue
            got = {}
            for r in csv.DictReader(gzip.open(path, "rt")):
                if r["bid"] and r["ask"] and float(r["ask"]) > 0 and float(r["bid"]) > 0:
                    got.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
            for k, v in got.items(): by.setdefault(k, sorted(v))
        RB.Q[date] = by
    return RB.Q[date]


RB.book = book


def ndx_signals():
    rows = json.load(open(f"{B}/list_ndx26_{A}_{Z}.json"))
    rows = rows if isinstance(rows, list) else rows.get("rows") or rows.get("signals") or []
    out = []
    for r in rows:
        stt = FR.STATUS.get(r.get("status"))
        if stt and A <= r["date"] <= Z: out.append(dict(r, status=stt, minute=str(r["minute"]), c_t=str(r.get("c_t", 9))))
    return out


def walk(job):
    src, kind, t = job
    if RB.DBX != fm.DBX["fav" if src != "fair" else "fair"]: RB.DBX = fm.DBX["fav" if src != "fair" else "fair"]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    if LISTING: return (date, c[0], max(m0 - 2, 0))
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    rcost, real, bk = g
    sells = [s for s in real if s[2] == "sell"]
    out = dict(src=src, kind=kind, date=date, sym=sym, right=right, minute=m0, d2=int(float(t.get("c_t") or 9) < 1.8), book=bk,
               r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
               over=int(any(s[0] != date for s in sells)))
    if kind == "main" and src != "ndx":
        held = {}
        for mm in range(m0, 390):
            q = RB.quote(c[0], date, mm)
            held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
        out["held"] = held
    return out


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15") if A <= t["date"] <= Z]
    jobs += [("fav", "main", t) for t in FR.signals("25") if A <= t["date"] <= Z]
    jobs += [("ndx", "main", t) for t in ndx_signals()]
    if not LISTING:
        jobs += [("fair", "add", t) for t in fe.fair_signals("s_t18r15") if A <= t["date"] <= Z]
        jobs += [("fav", "add", t) for t in FR.signals("24") if A <= t["date"] <= Z]
    print(len(jobs), "signals;", sum(j[0] == "ndx" for j in jobs), "on the Nasdaq-100", flush=True)
    if LISTING:
        jobs = [j for j in jobs if j[0] == "ndx"]
        with mp.Pool(8) as pool: rows = sorted({x for x in pool.map(walk, jobs, chunksize=4) if x})
        with open(os.path.join(HERE, "open5_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{len(rows)} contracts on {len({x[0] for x in rows})} days -> open5_dbx_list.csv"); return
    with mp.Pool(8) as pool: R = [r for r in pool.map(walk, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    M = [r for r in R if r["kind"] == "main"]
    hot = lambda kind: (lambda r: r["sym"] in HOT.get(r["date"][:7], {}).get(kind, []))
    LISTS = {
        "Favorites 2026": lambda r: r["src"] == "fav",
        "fair list 2026": lambda r: r["src"] == "fair",
        "NDX all": lambda r: r["src"] == "ndx",
        "NDX new (77)": lambda r: r["src"] == "ndx" and r["sym"] in NEW,
        "NDX momentum 20": lambda r: r["src"] == "ndx" and hot("momentum")(r),
        "NDX in play 20": lambda r: r["src"] == "ndx" and hot("inplay")(r),
        "Fav + NDX new": lambda r: r["src"] == "fav" or (r["src"] == "ndx" and r["sym"] in NEW),
        "Fav + NDX new momentum": lambda r: r["src"] == "fav" or (r["src"] == "ndx" and r["sym"] in NEW and hot("momentum")(r)),
        "Fav + NDX new in play": lambda r: r["src"] == "fav" or (r["src"] == "ndx" and r["sym"] in NEW and hot("inplay")(r)),
    }

    def entries(f, part, size):
        E = []
        for r in M:
            if half(r["date"]) != part or not f(r): continue
            E.append((r["date"], r["minute"], 1.0, r["r"][size], r["over"]))
            if not r["d2"] or "held" not in r: continue
            for ad in sorted(adds.get((r["src"], r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= r["minute"]: continue
                share, up = r["held"].get(ad["minute"], (0, None))
                if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["h"][size], ad["over"]))
                break
        return E

    for size in SIZES:
        print(f"\n#### {size:.0%}, 2026, tune and check side by side (end / worst drop; without the best 5)\n\n| List | Tune | Check | Without best 5 (tune / check) | Trades (tune / check) |\n|---|---|---|---|---|")
        for name, f in LISTS.items():
            t, c = rr.stats(entries(f, "tune", size), size), rr.stats(entries(f, "check", size), size)
            print(f"| {name} | ${t['acct']:,} / {t['dd']:.0%} | ${c['acct']:,} / {c['dd']:.0%} | ${t['no5']:,} / ${c['no5']:,} | {t['trades']} / {c['trades']} |", flush=True)
    print("\n#### The trades at $10K (2% returns): giants (+300%+), the median trade, the rest's sum, by half\n\n| List | Tune: trades, giants, median, rest | Check: trades, giants, median, rest |\n|---|---|---|")
    for name, f in LISTS.items():
        cells = []
        for part in ("tune", "check"):
            v = [1e4 * max(-1, r["r"][0.02]) for r in M if half(r["date"]) == part and f(r)]
            g = [x for x in v if x >= 3e4]
            cells.append(f"{len(v)}, {len(g)} ({sum(g):+,.0f}), {st.median(v) if v else 0:+,.0f}, {sum(v) - sum(g):+,.0f}")
        print(f"| {name} | {cells[0]} | {cells[1]} |", flush=True)
    N = [r for r in M if r["src"] == "ndx"]
    by = collections.defaultdict(list)
    for r in N: by[r["sym"]].append(1e4 * max(-1, r["r"][0.02]))
    print("\nNDX by stock (2026, both halves, $ at $10K): " + ", ".join(f"{s} {sum(v):+,.0f} ({len(v)})" for s, v in sorted(by.items(), key=lambda q: -sum(q[1]))))
    bk = [r["book"] for r in N]
    print(f"NDX fills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)} trades")


if __name__ == "__main__":
    main()
