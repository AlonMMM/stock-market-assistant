"""A second try for the looser D2 entries only (the user, 2026-10-27, after d2_window.py: "Can we test second try only for
enters with D2 bonus?"). d2_window.py lost because a looser D2 fires earlier on a weaker move and takes the stock's one
slot of the day. Here the champion is unchanged and a looser D2 signal is an EXTRA trade on top: one that fires before
the champion's own entry on that stock and day (or on a day the champion does not trade), by its D2 arm (t < 1.8). Set
before running: the looser rule c8_15 / c6_15 (t >= 0.8 / 0.6, 30 minutes) / w120 (t >= 1.2, 120 minutes without the
opening 15); the extra trade at full or half size, no pyramid on it. Real quotes, the champion's contract pick (IBIT
down to $0.10, no cheap fallback). Tune / check by entry week, the fair list and the Favorites 24 months.

  node --env-file=.env <dir>/run.mjs d2_second.py      (from the app repo root)
-> data/local/x/bt/d2_second_summary.json
"""
import collections, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import d2_window as DW
import fav_real as FR
import floor_exception as fe
from score_sum import account
from split import half

B = "data/local/x/bt"
LOOSE = {"c8_15": ("c8_15", "c8"), "c6_15": ("c6_15", "c6"), "w120": ("c12_15w120", "w120")}
SIZES = (1.0, 0.5)


def main():
    jobs = [("c12_15", "fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("c12_15", "fav", "main", t) for t in FR.signals("25")]
    for v, (rule, tag) in LOOSE.items():
        jobs += [(v, "fair", "main", t) for t in fe.fair_signals(f"sg_{rule}") if float(t["c_t"]) < 1.8]
        jobs += [(v, "fav", "main", t) for t in DW.fav_signals(tag) if float(t["c_t"]) < 1.8]
    jobs += [("add", "fair", "add", t) for t in fe.fair_signals("s_t18r15")] + [("add", "fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(DW.one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    champ_first = {}
    for r in R:
        if r["v"] == "c12_15" and r["kind"] == "main": champ_first[(r["src"], r["date"], r["sym"])] = r["minute"]

    def entries(src, part, loose, size, a=""):
        E = DW.entries(R, adds, "c12_15", src, part, a)
        extra = 0
        if loose:
            for r in R:
                if r["v"] != loose or r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
                first = champ_first.get((src, r["date"], r["sym"]))
                if first is not None and r["minute"] >= first: continue
                E.append((r["date"], r["minute"], size, sim.result(r["paid"], r["steps"], 0.01 * size), r["sym"], r["cov"], 1))
                extra += 1
        return E, extra

    out = {}
    print("\n### Tune weeks, real quotes, 1% from $100,000\n\n| Extra trades | Size | Fair list | Favorites 24m | Without the best 5 (fair / fav) | Extra trades (fair / fav) | Their P&L at $10K a unit (fair / fav) |\n|---|---|---|---|---|---|---|")
    rows = [("none", None, 1.0)] + [(v, v, s) for v in LOOSE for s in SIZES]
    for name, loose, size in rows:
        (ef, nf_), (ev, nv) = entries("fair", "tune", loose, size), entries("fav", "tune", loose, size, FR.A24)
        f, g = DW.stats(ef), DW.stats(ev)
        pf = round(sum(1e4 * e[2] * max(-1, e[3]) for e in ef if e[6] and e[2] == size and loose) )
        out[f"tune|{name}|{size}"] = dict(fair=f, fav=g, extra=(nf_, nv))
        xf = sum(1e4 * e[2] * max(-1, e[3]) for e in entries("fair", "tune", loose, size)[0][-nf_:]) if nf_ else 0
        xv = sum(1e4 * e[2] * max(-1, e[3]) for e in entries("fav", "tune", loose, size, FR.A24)[0][-nv:]) if nv else 0
        print(f"| {name} | {size:g}x | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} | {nf_} / {nv} | {xf:+,.0f} / {xv:+,.0f} |", flush=True)
    base = out["tune|none|1.0"]
    score = lambda k: min(out[k]["fair"]["acct"] / base["fair"]["acct"], out[k]["fav"]["acct"] / base["fav"]["acct"])
    best = max((k for k in out if k != "tune|none|1.0"), key=score)
    _, bv, bs = best.split("|")
    print(f"\nPicked on tune: {bv} at {bs}x; better than the champion on both tune lists: {score(best) > 1}\n")
    print("### Check weeks, one run\n\n| Extra trades | Fair list | Favorites 24m | Without the best 5 (fair / fav) |\n|---|---|---|---|")
    for name, loose, size in (("none", None, 1.0), (bv, bv, float(bs))):
        f, g = DW.stats(entries("fair", "check", loose, size)[0]), DW.stats(entries("fav", "check", loose, size, FR.A24)[0])
        out[f"check|{name}|{size}"] = dict(fair=f, fav=g)
        print(f"| {name} {size:g}x | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} |", flush=True)
    json.dump(out, open(f"{B}/d2_second_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
