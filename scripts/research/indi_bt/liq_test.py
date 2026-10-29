"""The champion on the liquid movers (the user, 2026-10-29: "I want more stockes with good spread and good io in options",
"also stock that know to move ... more than 3% at day", "You need the hight oi and good spread filter first").

The list: liquid_movers.txt from opt_liq.py (2025 only: movers by price, $ volume and 3% days, then weekly options,
median OI >= 1,000 a strike and spread <= 10% in the nearest weekly): MARA AAL RIOT RIVN CLSK SOUN RGTI CLF APLD TSM.
Signals: lists.py liq10_25 (the champion's entry) and liq10_24 (t >= 1.8, for the pyramid add), 2025-01-02 to
2026-10-23; the champion's pick, exits and pyramid (retry_roll.py), real quotes (LQ_PASS=list -> open7_dbx_list.csv,
dbx_fetch.py open7). Versions: the Favorites (60), the 10 alone, the Favorites + the 10; tune AND check (split.py), 2026
(the clean test: the list was picked on 2025) and 2025 beside it, 2% and 3%; the giants, the median and the rest.

  node --env-file=.env <dir>/run.mjs liq_test.py (LQ_PASS=list first, then dbx_fetch.py open7)   (from the app repo root)
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
A, Z = "2025-01-02", "2026-10-23"
LISTING = os.environ.get("LQ_PASS") == "list"
# LQ_NAME: the list (liq10 = the liquid movers; lev12 = the leveraged ETFs, the user 2026-10-29: "can you check SOXL,
# TQQQ, and other like them?"); its signals are list_<name>_25 / _24, its quotes dbx_cache/open7 (open8 for lev12)
NAME = os.environ.get("LQ_NAME", "liq10")
QDIR = {"liq10": "open7", "lev12": "open8"}[NAME]
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open5", "open7", "open8")]
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


def ndx_signals(name="liq10_25"):
    rows = json.load(open(f"{B}/list_{name}_{A}_{Z}.json"))
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
    if kind == "main":
        held = {}
        for mm in range(m0, 390):
            q = RB.quote(c[0], date, mm)
            held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
        out["held"] = held
    return out


def main():
    jobs = [("fav", "main", t) for t in FR.signals("25") if A <= t["date"] <= Z]
    jobs += [("ndx", "main", t) for t in ndx_signals(f"{NAME}_25")]
    if not LISTING:
        jobs += [("fav", "add", t) for t in FR.signals("24") if A <= t["date"] <= Z]
        jobs += [("ndx", "add", t) for t in ndx_signals(f"{NAME}_24")]
    print(len(jobs), "signals;", sum(j[0] == "ndx" for j in jobs), "on the Nasdaq-100", flush=True)
    if LISTING:
        jobs = [j for j in jobs if j[0] == "ndx"]
        with mp.Pool(8) as pool: rows = sorted({x for x in pool.map(walk, jobs, chunksize=4) if x})
        with open(os.path.join(HERE, f"{QDIR}_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{len(rows)} contracts on {len({x[0] for x in rows})} days -> {QDIR}_dbx_list.csv"); return
    with mp.Pool(8) as pool: R = [r for r in pool.map(walk, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    M = [r for r in R if r["kind"] == "main"]
    LISTS = {}
    for yr in ("2026", "2025"):
        LISTS[f"{yr} · Favorites (60)"] = (lambda y: lambda r: r["src"] == "fav" and r["date"][:4] == y)(yr)
        LISTS[f"{yr} · {NAME} alone"] = (lambda y: lambda r: r["src"] == "ndx" and r["date"][:4] == y)(yr)
        LISTS[f"{yr} · Favorites + {NAME}"] = (lambda y: lambda r: r["date"][:4] == y)(yr)

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
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| List | Tune | Check | Without best 5 (tune / check) | Trades (tune / check) |\n|---|---|---|---|---|")
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
    N = [r for r in M if r["src"] == "ndx" and r["date"] >= "2026"]
    by = collections.defaultdict(list)
    for r in N: by[r["sym"]].append(1e4 * max(-1, r["r"][0.02]))
    print("\nThe 10 by stock (2026, both halves, $ at $10K): " + ", ".join(f"{s} {sum(v):+,.0f} ({len(v)})" for s, v in sorted(by.items(), key=lambda q: -sum(q[1]))))
    bk = [r["book"] for r in N]
    print(f"The 10's fills on the real book (2026): {sum(bk) / max(1, len(bk)):.0%} of {len(bk)} trades")


if __name__ == "__main__":
    main()
