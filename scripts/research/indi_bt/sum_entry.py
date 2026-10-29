"""The sum entry (the user, 2026-10-28: "Buy if the sum of t d2 and volume is more than 4.5 AND t>=0.8").

A signal at the first minute (09:40-15:44, one a stock and day, either side) where t + D2 + the day volume ratio > S and
t >= 0.8, on the bet's side (defence_signals.py rule sXX_08, BT_SIG_SUFFIX=_sum: t vs SPY x beta since the open, D2 the
excess on SPY's bad minutes of the last 30 in S30 units, the volume ratio the day's volume so far over its usual at that
minute). Then the champion's pipeline: the news filter (no earnings reaction day, pre-market volume under 4x), the fair
list (Indi's stocks known before each year) and the Favorites (24 months), the champion's pick (0.15 delta, IBIT down to
$0.10, 200 contracts) and exits, the pyramid add (half a size on the full signal later that day while held and up) after
an entry with t under 1.8. Set before running: S 4.5 (4.0 / 5.0 the neighbours), as
  alone   the sum rule instead of the champion's entry
  added   the champion's entry or the sum rule, whichever comes first that day
One run, tune AND check (split.py), 2% and 3%, picked on tune by min(fair, Favorites) money. The sum signals' new
contracts are priced on the real book when the quote cache has them, else the walk's +-2% (the share is printed).

  BT_RULES=s40_08,s45_08,s50_08 BT_SIG_SUFFIX=_sum BT_SPAN_END=2026-10-23 BT_SYMS=... run.mjs defence_signals.py, then
  node --env-file=.env <dir>/run.mjs sum_entry.py      (from the app repo root)
"""
import collections, csv, glob, json, multiprocessing as mp, os, sys
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
LEVELS = ("40", "45", "50")
Z = FR.Z
FAV = sorted({t["sym"] for t in FR.signals("25")} | {t["sym"] for t in FR.signals("24")})


def sum_signals(level):
    T = [dict(r, status="ok") for f in glob.glob(f"{B}/s_sig_s{level}_08_sum_20*.csv") for r in csv.DictReader(open(f))]
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
        V[f"alone-{lv}"] = {src: {} for src in base}
        V[f"added-{lv}"] = {src: {(t["date"], t["sym"]): t for t in base[src]} for src in base}
        for src in base:
            for t in sorted(sums[lv][src], key=lambda t: int(t["minute"])):
                k = (t["date"], t["sym"])
                V[f"alone-{lv}"][src].setdefault(k, t)
                cur = V[f"added-{lv}"][src].get(k)
                if cur is None or int(t["minute"]) < int(cur["minute"]): V[f"added-{lv}"][src][k] = t
    for src in base:
        for lv in LEVELS:
            print(f"{src} S {int(lv) / 10}: sum signals {len(sums[lv][src])}; tune days alone {sum(half(k[0]) == 'tune' for k in V[f'alone-{lv}'][src])}, "
                  f"added {sum(half(k[0]) == 'tune' for k in V[f'added-{lv}'][src])} vs the champion's {sum(half(k[0]) == 'tune' for k in V['base'][src])}", flush=True)
    jobs = {}
    for v in V.values():
        for src, d in v.items():
            for t in d.values(): jobs[key(src, t)] = (src, t)
    for src in adds:
        for t in adds[src]: jobs[("add",) + key(src, t)] = (src, t)
    print(len(jobs), "walks", flush=True)
    ks = list(jobs)
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
    # where the sum rule's own trades stand: the stock-days it adds or moves, tune, at $10K a trade
    for lv in LEVELS:
        for src in ("fair", "fav"):
            new = [W.get(key(src, t)) for k, t in V[f"added-{lv}"][src].items() if half(k[0]) == "tune" and k not in V["base"][src]]
            moved = [(W.get(key(src, t)), W.get(key(src, V["base"][src][k]))) for k, t in V[f"added-{lv}"][src].items()
                     if half(k[0]) == "tune" and k in V["base"][src] and t is not V["base"][src][k]]
            new = [x for x in new if x]; moved = [(x, y) for x, y in moved if x and y]
            bk = [x["book"] for x in new]
            print(f"S {int(lv) / 10} {src} tune: {len(new)} new stock-days, {sum(x['r'][0.02] > 0 for x in new)} winners, sum {1e4 * sum(max(-1, x['r'][0.02]) for x in new):+,.0f}"
                  f" (book {sum(bk) / max(1, len(bk)):.0%}); {len(moved)} earlier entries, {1e4 * sum(x['r'][0.02] for x, _ in moved):+,.0f} vs the champion's "
                  f"{1e4 * sum(y['r'][0.02] for _, y in moved):+,.0f}", flush=True)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/sum_entry_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
