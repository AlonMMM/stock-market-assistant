"""No entries in the first 30 minutes unless the signal is very strong (the user, 2026-10-30: "Simply try to not to trade
in the first 30 minutes unless the tresholds are very big", after his_vs_bot.py: the bot's median entry 09:51, 62% before
10:00; Indi's 11:35, 18%; "you can also test you choosing").

The champion's signal rule (c12_15) regenerated with its first minute at 30 (10:00) and 60 (10:30) (defence_signals.py
BT_FIRST, suffix _f30 / _f60); an entry before that minute is kept only when the 09:40-start signal (_f10, the control)
is very strong at its minute, else the stock-day waits for the later start's first signal. Set before running:
  f30         from 10:00, no early entry
  f30-x25     early entry kept if t >= 2.5 and the day's volume >= 2.5x
  f30-x30     t >= 3.0 and volume >= 3.0x
  f30-t30     t >= 3.0 (volume as the rule, 1.5x)
  f30-v30     volume >= 3.0x (t as the rule)
  f60-x25     from 10:30, early kept if t >= 2.5 and volume >= 2.5x (my pick: Indi's entries start later still)
Then the champion's pipeline (news filter, fair list + Favorites 24 months, pick, exits, pyramid add), tune AND check,
2% and 3%, picked on tune by min(fair, Favorites); the giants of the moved and dropped entries.
Real quotes: LS_PASS=list -> open17_dbx_list.csv, dbx_fetch.py open17.

  node --env-file=.env <dir>/run.mjs late_start.py      (from the app repo root; LS_PASS=list and dbx_fetch.py open17 first)
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
LEVELS = ("f10", "f30", "f60")
LISTING = os.environ.get("LS_PASS") == "list"
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open17")]
# version -> (start minute, early t floor, early volume floor)
LATE = {"f30": (30, 99, 99), "f30-x25": (30, 2.5, 2.5), "f30-x30": (30, 3.0, 3.0), "f30-t30": (30, 3.0, 1.5), "f30-v30": (30, 1.8, 3.0), "f60-x25": (60, 2.5, 2.5)}


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
    first = {}
    for lv in LEVELS:
        first[lv] = {src: {} for src in base}
        for src in base:
            for t in sorted(sums[lv][src], key=lambda t: int(t["minute"])): first[lv][src].setdefault((t["date"], t["sym"]), t)
    V["f10"] = first["f10"]
    for v, (start, tf, vf) in LATE.items():
        late = first[f"f{start}"]
        V[v] = {src: {} for src in base}
        for src in base:
            for k in set(first["f10"][src]) | set(late[src]):
                e = first["f10"][src].get(k)
                if e and int(e["minute"]) < start and float(e["c_t"] or 0) >= tf and float(e["c_rvol"] or 0) >= vf: V[v][src][k] = e
                elif k in late[src]: V[v][src][k] = late[src][k]
    for src in base:
        for lv in V:
            if lv == "base": continue
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
        with open(os.path.join(HERE, "open17_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{len(rows)} contracts on {len({x[0] for x in rows})} days -> open17_dbx_list.csv"); return
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
    for lv in [v for v in V if v != "base"]:
        for src in ("fair", "fav"):
            both = [(W.get(key(src, t)), W.get(key(src, V["base"][src][k]))) for k, t in V[lv][src].items() if half(k[0]) == "tune" and k in V["base"][src]]
            both = [(x, y) for x, y in both if x and y]
            moved = [(x, y) for x, y in both if x["minute"] != y["minute"] or x["right"] != y["right"]]
            new = [W.get(key(src, t)) for k, t in V[lv][src].items() if half(k[0]) == "tune" and k not in V["base"][src]]
            new = [x for x in new if x]
            bk = [x["book"] for x, _ in moved] + [x["book"] for x in new]
            gone = [W.get(key(src, t)) for k, t in V["base"][src].items() if half(k[0]) == "tune" and k not in V[lv][src]]
            gone = [y for y in gone if y]
            gi = lambda X: sum(1e4 * max(-1, x["r"][0.02]) >= 3e4 for x in X)
            print(f"{lv} {src} tune: {len(moved)} entries at another minute, {1e4 * sum(max(-1, x['r'][0.02]) for x, _ in moved):+,.0f} (giants {gi([x for x, _ in moved])}) vs the champion's "
                  f"{1e4 * sum(max(-1, y['r'][0.02]) for _, y in moved):+,.0f} (giants {gi([y for _, y in moved])}); {len(new)} new stock-days {1e4 * sum(max(-1, x['r'][0.02]) for x in new):+,.0f} (giants {gi(new)}); "
                  f"{len(gone)} champion stock-days dropped {1e4 * sum(max(-1, y['r'][0.02]) for y in gone):+,.0f} (giants {gi(gone)}) (book {sum(bk) / max(1, len(bk)):.0%})", flush=True)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/late_start_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
