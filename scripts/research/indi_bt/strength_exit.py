"""The strength exit off (the user, 2026-10-28: "if we remove the strengh exit?"). On the champion of retry_roll.py (2.5 +
IBIT down to $0.10 + the pyramid, real quotes), the entry-day exit that sells all when the signal's own t vs SPY x beta
falls to `t` (CHAMP "thesis" {"t": 0.5}, added 2026-10-24 on the t >= 1.8 bot: +$25K fair, -$349 unseen). Set before
running: champion (t 0.5), off, t 0.25 and t 0.0 (neighbours: a looser exit). Each version walks the mains and the
pyramid adds with its own exits; the add's gate reads that version's held share. One run, tune AND check (split.py),
fair list + Favorites 24m, 2% and 3%; the pick on tune by min(fair, Favorites) money against the champion.

  node --env-file=.env <dir>/run.mjs strength_exit.py      (from the app repo root)
"""
import collections, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from d2_failed_break import CHAMP
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
VERSIONS = {"champion": CHAMP, "off": {k: v for k, v in CHAMP.items() if k != "thesis"},
            "t0.25": {**CHAMP, "thesis": {"t": 0.25}}, "t0.0": {**CHAMP, "thesis": {"t": 0.0}}}


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8), v={})
    mids = None
    for v, ex in VERSIONS.items():
        g = rr.leg(sym, date, m0, right, c, ex)
        if not g: continue
        rcost, real, _ = g
        sells = [s for s in real if s[2] == "sell"]
        r = dict(r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                 over=int(any(s[0] != date for s in sells)), exits=collections.Counter(s[5] for s in sells))
        if kind == "main":
            if mids is None:
                mids = {}
                for mm in range(m0, 390):
                    k = RB.quote(c[0], date, mm)
                    mids[mm] = None if not k else (k[0] + k[1]) / 2
            r["held"] = {mm: (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if p is None else p / rcost - 1) for mm, p in mids.items()}
        out["v"][v] = r
    return out if out["v"] else None


def entries(R, adds, src, v, part, size, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x = r["v"][v]
        E.append((r["date"], r["minute"], 1.0, x["r"][size], x["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0 and v in ad["v"]: E.append((ad["date"], ad["minute"], 0.5, ad["v"][v]["h"][size], ad["v"][v]["over"]))
            break
    return E


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    L = (("fair", ""), ("fav", FR.A24))
    out = {(s, p, v): [rr.stats(entries(R, adds, src, v, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in VERSIONS}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) | Trades tune (fair / fav) |\n|---|---|---|---|---|---|---|---|")
        for v in VERSIONS:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} | {tf['trades']} / {tv['trades']} |", flush=True)
    b = out[(0.02, "tune", "champion")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max((v for v in VERSIONS if v != "champion"), key=sc)
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f})")
    for src in ("fair", "fav"):
        ex = {v: sum((r["v"][v]["exits"] for r in R if r["src"] == src and r["kind"] == "main" and v in r["v"] and half(r["date"]) == "tune"), collections.Counter()) for v in VERSIONS}
        print(f"exit labels, tune mains, {src}: " + " | ".join(f"{v}: " + ", ".join(f"{k} {n}" for k, n in ex[v].most_common(6)) for v in VERSIONS))
    # the trades the exit changes most (tune, 2%, mains)
    for src in ("fair", "fav"):
        ch = sorted(((r["v"]["off"]["r"][0.02] - r["v"]["champion"]["r"][0.02], r) for r in R if r["src"] == src and r["kind"] == "main"
                     and half(r["date"]) == "tune" and "off" in r["v"] and "champion" in r["v"]), key=lambda q: q[0])
        ch = [q for q in ch if abs(q[0]) > 1e-6]
        print(f"\n{src} tune: {len(ch)} trades end differently without the exit, their sum at $10K {1e4 * sum(q[0] for q in ch):+,.0f}; "
              f"better {sum(q[0] > 0 for q in ch)}, worse {sum(q[0] < 0 for q in ch)}")
        for d, r in ch[:5] + ch[-5:]:
            print(f"  {r['date']} {r['sym']} {r['right']}: {r['v']['champion']['r'][0.02]:+.0%} -> {r['v']['off']['r'][0.02]:+.0%}")
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/strength_exit_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
