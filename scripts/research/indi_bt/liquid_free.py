"""The most liquid names trade without conditions (the user, 2026-10-31, after skip_funnel.py: "the names that are in the
top liqude option will be trade without conditions").

The liquid names, set before running from skip_funnel.py (thin + too cheap <= 10% of their fair-list signals):
  TOP5   AAPL AMD TSLA AMZN NVDA
  TOP10  + META GOOGL MSFT PLTR IBIT (the next five by the share traded)
On the champion (retry_roll.py base: 2.5 + IBIT $0.10 + the pyramid, real quotes), for a main signal on a liquid name:
  top5_nf / top10_nf     no news skip (pre-market volume >= 4x) and no earnings-reaction-day skip; the liquidity floor kept
  top5_all / top10_all   no skip at all: also the 0.15-delta pick when it is thin or under the price floor
One trade a stock a day; a new trade gets the champion's exits, no pyramid add. One run, tune AND check (split.py), fair
list + Favorites (24 months), 2% and 3%, picked on tune by min(fair, Favorites); the new trades: count, giants, median, sum.
The news skip off for every stock was not better (premarket_toggle.py, 2026-10-27). Real quotes for the new legs:
LQ_PASS=list -> open21_dbx_list.csv, dbx_fetch.py open21.

  node --env-file=.env <dir>/run.mjs liquid_free.py      (from the app repo root; LQ_PASS=list and dbx_fetch.py open21 first)
"""
import collections, csv, gzip, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import spy_rules as SR
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import news_filter as nf
import glob
from low_delta import HIS40, PRIOR
import real_bench as RB
from d2_failed_break import CHAMP
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
LISTING = os.environ.get("LQ_PASS") == "list"
SR.VERSIONS = {"champion": CHAMP}
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open17", "open18", "open21")]
LAST = 374
VERS = ("top5_nf", "top10_nf", "top5_all", "top10_all")
TOP5 = {"AAPL", "AMD", "TSLA", "AMZN", "NVDA"}
TOP10 = TOP5 | {"META", "GOOGL", "MSFT", "PLTR", "IBIT"}


def book(date):
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


def thin(sym, date, m, right, price):
    """True when the champion's pick at m is over the price floor but under 200 contracts in 30 minutes."""
    cands = cu.candidates(sym, date, m, right, price)
    if not cands: return False
    b = min(cands, key=lambda c: abs(c[3] - 0.15))
    return b[4] >= (0.10 if sym == "IBIT" else 0.20) and b[5] < 200


def rule_minutes(sym, date, right):
    v = rr.ALL.get(("c12_15", sym, date, right))
    return v[0] if v else []


def try_at(sym, date, m, right):
    cl = rr.closes(sym, date)
    px = next((cl[k] for k in range(m, -1, -1) if cl[k]), None)
    if not px: return None
    return rr.pick(sym, date, m, right, px)


def walk_free(job):
    """A liquid name's signal the champion skips (filt: the news / earnings skip; liq: the pick) -> {version: trade or None}."""
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0, px = t["sym"], t["date"], t["right"], int(t["minute"]), float(t["price"])
    pk = rr.pick(sym, date, m0, right, px)
    if kind == "liq" and pk: return None
    c = pk
    if not c:
        cands = cu.candidates(sym, date, m0, right, px)
        if not cands: return None
        b = min(cands, key=lambda x: abs(x[3] - 0.15)); c = (b[0], b[1])
    if LISTING: return [(date, c[0], max(m0 - 2, 0))]
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    rcost, real, bk = g
    y = dict(minute=m0, right=right, contract=c[0], r={s: sim.result(rcost, real, s) for s in SIZES},
             over=int(any(s[0] != date for s in real if s[2] == "sell")), book=bk)
    v = {}
    for name, names in (("top5", TOP5), ("top10", TOP10)):
        v[f"{name}_nf"] = y if sym in names and kind == "filt" and pk else None
        v[f"{name}_all"] = y if sym in names else None
    return dict(src=src, date=date, sym=sym, right=right, m0=m0, v=v)


class _Status(dict):
    """fav_real.STATUS with the news / earnings skips kept, marked."""
    def get(self, k, d=None):
        if k.startswith("skipped: pre-market volume") or k.startswith("skipped: earnings"): return "filt"
        return super().get(k, d)


def fav_filtered():
    old = FR.STATUS; FR.STATUS = _Status(old)
    try: return [t for t in FR.signals("25") if t["status"] == "filt" and t["sym"] in TOP10]
    finally: FR.STATUS = old


def fair_filtered():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    return [t for t in T if t["sym"] in TOP10 and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST
            and (t["e_next"] == 0 or (t["pre_rvol"] is not None and t["pre_rvol"] >= 4))]


def main():
    mains = [("fair", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25")]
    jobs = [("fair", "main", t) for _, t in mains if _ == "fair"] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for s, t in mains if s == "fav"] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(mains), "main signals", flush=True)
    free = [(src, "liq", t) for src, t in mains if t["sym"] in TOP10] + [("fair", "filt", t) for t in fair_filtered()] + [("fav", "filt", t) for t in fav_filtered()]
    print(len(free), "liquid-name jobs", collections.Counter(k for _, k, _ in free), flush=True)
    with mp.Pool(8) as pool: X = [x for x in pool.map(walk_free, free, chunksize=4) if x]
    if LISTING:
        rows = sorted({y for x in X for y in x})
        with open(os.path.join(HERE, "open21_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{len(rows)} rows on {len({r[0] for r in rows})} days -> open21_dbx_list.csv"); return
    print(len(X), "new liquid-name trades", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(SR.one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    L = (("fair", ""), ("fav", FR.A24))

    def entries(v, src, part, size, a):
        E = SR.entries(R, adds, src, "champion", part, size, a)
        if v == "champion": return E
        for x in X:
            y = x["v"].get(v)
            if y and x["src"] == src and half(x["date"]) == part and x["date"] >= a: E.append((x["date"], y["minute"], 1.0, y["r"][size], y["over"]))
        return E
    V = ("champion",) + VERS
    out = {(s, p, v): [rr.stats(entries(v, src, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in V}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) |\n|---|---|---|---|---|---|---|")
        for v in V:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} |", flush=True)
    b = out[(0.02, "tune", "champion")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max(VERS, key=sc)
    bc, pc = out[(0.02, "check", "champion")], out[(0.02, "check", best)]
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
          f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}")
    print("\n#### The added trades ($10K a trade, 2% returns): n, won, median, sum, giants (+300%), the rest; minutes after the signal (median, 0)\n\n| Version | Half | Fair | Favorites |\n|---|---|---|---|")
    for v in VERS:
        for part in ("tune", "check"):
            cells = []
            for src, a in L:
                Y = [(x, x["v"][v]) for x in X if x["v"].get(v) and x["src"] == src and half(x["date"]) == part and x["date"] >= a]
                u = [1e4 * max(-1, y["r"][0.02]) for _, y in Y]; g = [q for q in u if q >= 3e4]
                cells.append(f"{len(u)}, {sum(q > 0 for q in u)}, {st.median(u) if u else 0:+,.0f}, {sum(u):+,.0f}, {len(g)}, {sum(u) - sum(g):+,.0f}; "
                             f"{st.median([y['minute'] - x['m0'] for x, y in Y]) if Y else 0:.0f} min" + (f"; giants: {', '.join(x['sym'] + ' ' + x['date'] for (x, y), q in zip(Y, u) if q >= 3e4)}" if g else ""))
            print(f"| {v} | {part} | {cells[0]} | {cells[1]} |", flush=True)
    bk = [y["book"] for x in X for y in x["v"].values() if y]
    print(f"\nnew trades: {len(X)}; new legs' fills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/liquid_free_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
