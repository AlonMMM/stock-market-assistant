"""When the bot may first enter (the user, 2026-10-28: "What if we start at 5 minutes after the bell? 15 minutes?").

The champion's signal rule (defence_signals.py c12_15: t >= 1.8 with the day volume >= 1.5x, or the D2 bonus t >= 1.2 and
D2 >= 1.5) regenerated with its first minute at 5 (09:35), 10 (09:40, the control: it should match the champion) and
15 (09:45) (BT_FIRST; the t needs min(10, first) steps), one signal a stock and day; then the champion's pipeline: the
news filter, the fair list and the Favorites (24 months), the champion's pick, exits and pyramid add. Set before running:
f05, f10 (control), f15 against the champion's own signal files. One run, tune AND check (split.py), 2% and 3%, picked on
tune by min(fair, Favorites) money. Real quotes: a listing pass (ES_PASS=list -> open3_dbx_list.csv, then
dbx_fetch.py open3 -> dbx_cache/open3) fetches the new contracts; the book reads all the caches.

  BT_RULES=c12_15 BT_FIRST=5|10|15 BT_SIG_SUFFIX=_f05|_f10|_f15 BT_SPAN_END=2026-10-23 BT_SYMS=... defence_signals.py,
  then ES_PASS=list entry_start.py, dbx_fetch.py open3, entry_start.py      (run.mjs, from the app repo root)
"""
import collections, csv, glob, gzip, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import news_filter as nf
import real_bench as RB
from low_delta import HIS40, PRIOR
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
LEVELS = ("f05", "f10", "f15")
LISTING = os.environ.get("ES_PASS") == "list"
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3")]


def book(date):
    """real_bench.book over the list's cache and the extra fetches."""
    if date not in RB.Q:
        if len(RB.Q) > 3: RB.Q.clear()
        by = {}
        for d in [RB.DBX] + EXTRAS:
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
Z = FR.Z
FAV = sorted({t["sym"] for t in FR.signals("25")} | {t["sym"] for t in FR.signals("24")})


def sum_signals(level):
    T = [dict(r, status="ok") for f in glob.glob(f"{B}/s_sig_c12_15_{level}_20*.csv") for r in csv.DictReader(open(f))]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    fair = [t for t in T if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST]
    fav = [t for t in T if t["sym"] in FAV and FR.A24 <= t["date"] <= Z]
    return fair, fav


def walk(job):
    src, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    if LISTING: return (date, c[0], max(m0 - 2, 0))
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    rcost, real, book = g
    sells = [s for s in real if s[2] == "sell"]
    held = {}
    for mm in range(m0, 390):
        k = RB.quote(c[0], date, mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return dict(src=src, date=date, sym=sym, right=right, minute=m0, d2=int(float(t.get("c_t") or 9) < 1.8),
                r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                over=int(any(s[0] != date for s in sells)), held=held, book=book)


def key(src, t): return (src, t["date"], t["sym"], t["right"], int(t["minute"]))


def main():
    base = {"fair": fe.fair_signals("sg_c12_15"), "fav": FR.signals("25")}
    adds = {"fair": fe.fair_signals("s_t18r15"), "fav": FR.signals("24")}
    sums = {lv: dict(zip(("fair", "fav"), sum_signals(lv))) for lv in LEVELS}
    # the versions' mains: (src, date, sym) -> the signal row
    V = {"base": {src: {(t["date"], t["sym"]): t for t in base[src]} for src in base}}
    for lv in LEVELS:
        V[lv] = {src: {} for src in base}
        for src in base:
            for t in sorted(sums[lv][src], key=lambda t: int(t["minute"])): V[lv][src].setdefault((t["date"], t["sym"]), t)
    for src in base:
        for lv in LEVELS:
            same = sum(1 for k, t in V[lv][src].items() if k in V["base"][src] and int(t["minute"]) == int(V["base"][src][k]["minute"]) and t["right"] == V["base"][src][k]["right"])
            print(f"{src} first minute {lv}: {len(V[lv][src])} stock-days vs the champion's {len(V['base'][src])}; the same day, side and minute: {same}", flush=True)
    jobs = {}
    for v in V.values():
        for src, d in v.items():
            for t in d.values(): jobs[key(src, t)] = (src, t)
    for src in adds:
        for t in adds[src]: jobs[("add",) + key(src, t)] = (src, t)
    print(len(jobs), "walks", flush=True)
    ks = list(jobs)
    if LISTING:
        ks = [k for k in ks if k[0] != "add"]
        with mp.Pool(8) as pool: rows = sorted({x for x in pool.map(walk, [jobs[k] for k in ks], chunksize=4) if x})
        with open(os.path.join(HERE, "open3_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{len(rows)} contracts on {len({x[0] for x in rows})} days -> open3_dbx_list.csv"); return
    with mp.Pool(8) as pool: W = dict(zip(ks, pool.map(walk, [jobs[k] for k in ks], chunksize=4)))
    A = collections.defaultdict(list)
    for k, w in W.items():
        if k[0] == "add" and w: A[(w["src"], w["date"], w["sym"], w["right"])].append(w)

    def entries(v, src, part, size, a=""):
        E = []
        for (date, sym), t in V[v][src].items():
            if half(date) != part or date < a: continue
            x = W.get(key(src, t))
            if not x: continue
            E.append((date, x["minute"], 1.0, x["r"][size], x["over"]))
            if not x["d2"]: continue
            for ad in sorted(A.get((src, date, sym, x["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= x["minute"]: continue
                share, up = x["held"].get(ad["minute"], (0, None))
                if share > 0 and up is not None and up > 0: E.append((date, ad["minute"], 0.5, ad["h"][size], ad["over"]))
                break
        return E

    L = (("fair", ""), ("fav", FR.A24))
    out = {(s, p, v): [rr.stats(entries(v, src, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in V}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) | Trades tune (fair / fav) |\n|---|---|---|---|---|---|---|---|")
        for v in V:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} | {tf['trades']} / {tv['trades']} |", flush=True)
    b = out[(0.02, "tune", "base")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max((v for v in V if v != "base"), key=sc)
    bc, pc = out[(0.02, "check", "base")], out[(0.02, "check", best)]
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
          f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}")
    # the entries that moved: the stock-days both trade, by when each version entered (tune, $10K a trade)
    for lv in LEVELS:
        for src in ("fair", "fav"):
            both = [(W.get(key(src, t)), W.get(key(src, V["base"][src][k]))) for k, t in V[lv][src].items() if half(k[0]) == "tune" and k in V["base"][src]]
            both = [(x, y) for x, y in both if x and y]
            moved = [(x, y) for x, y in both if x["minute"] != y["minute"] or x["right"] != y["right"]]
            new = [W.get(key(src, t)) for k, t in V[lv][src].items() if half(k[0]) == "tune" and k not in V["base"][src]]
            new = [x for x in new if x]
            bk = [x["book"] for x, _ in moved] + [x["book"] for x in new]
            print(f"{lv} {src} tune: {len(moved)} entries at another minute, {1e4 * sum(x['r'][0.02] for x, _ in moved):+,.0f} vs the champion's "
                  f"{1e4 * sum(y['r'][0.02] for _, y in moved):+,.0f}; {len(new)} stock-days the champion does not trade, {1e4 * sum(max(-1, x['r'][0.02]) for x in new):+,.0f}"
                  f" (book {sum(bk) / max(1, len(bk)):.0%})", flush=True)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/entry_start_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
