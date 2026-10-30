"""The champion, only on the leader (the user, 2026-10-30, after his_tvd.py: "take best 2, than best 1. try d 2 as
suggested and d 1.5 as well").

his_tvd.py: Indi's giants came 5x as often when his stock was in the top 5% of t among the other stocks at that
minute, and 4x as often when the 30-minute D2 had reached 2 at some point that day. Filters on the champion's own
entries (retry_roll.py base: 2.5 + IBIT down to $0.10 + the pyramid, real quotes), at the signal's minute, on its side:
  rank   its t's place among the stocks of our lists at that minute (his 40 + the Favorites, his_tvd.arrays):
         top2 = first or second, top1 = first
  d2max  the highest 30-minute D2 so far today (from 09:40): >= 2 (d2-20) or >= 1.5 (d2-15)
Versions (set before running): top2, top1, d2-20, d2-15, and each rank with each D2. A filtered-out entry is not
re-tried later that day; its pyramid add goes with it. One run, tune AND check (split.py), fair list + Favorites (24
months), 2% and 3%, picked on tune by min(fair, Favorites); the giants, the median and the rest of the kept trades.

  node --env-file=.env <dir>/run.mjs peer_rank.py      (from the app repo root)
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import spy_rules as SR
import retry_roll as rr
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import his_tvd as HT
from d2_failed_break import CHAMP
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
SR.VERSIONS = {"champion": CHAMP}
RULES = {"champion": (99, None), "top2": (2, None), "top1": (1, None), "d2-20": (99, 2.0), "d2-15": (99, 1.5),
         "top2-d2-20": (2, 2.0), "top2-d2-15": (2, 1.5), "top1-d2-20": (1, 2.0), "top1-d2-15": (1, 1.5)}


def feats(job):
    """(date, [signal keys]) -> {key: (rank, d2max)}: the signal's t rank among the peers at its minute, its D2 best so far."""
    date, S = job
    syms = sorted(set(HT.PEERS) | {s[2] for s in S})
    A = {s: HT.arrays(s, date) for s in syms}
    out = {}
    for k in S:
        _, _, sym, right, m = k
        a = A.get(sym)
        if not a or m not in a[right]: continue
        x = a[right][m]
        rank = 1 + sum(1 for s in HT.PEERS if s != sym and A.get(s) and m in A[s][right] and A[s][right][m]["t"] > x["t"])
        out[k] = (rank, x["d2max"])
    return out


def keep(r, F, rule):
    top, d2 = RULES[rule]
    f = F.get((r["src"], r["date"], r["sym"], r["right"], r["minute"]))
    if f is None: return rule == "champion"
    return f[0] <= top and (d2 is None or f[1] >= d2)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    by = collections.defaultdict(list)
    for src, kind, t in jobs:
        if kind == "main": by[t["date"]].append((src, t["date"], t["sym"], t["right"], int(t["minute"])))
    with mp.Pool(8) as pool:
        F = {}
        for d in pool.map(feats, sorted(by.items()), chunksize=4): F.update(d)
        R = [r for r in pool.map(SR.one, jobs, chunksize=4) if r]
    print(len(F), "main signals measured", flush=True)
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    M = [r for r in R if r["kind"] == "main"]
    L = (("fair", ""), ("fav", FR.A24))
    kept = {v: [r for r in M if keep(r, F, v)] for v in RULES}
    out = {(s, p, v): [rr.stats(SR.entries(kept[v], adds, src, "champion", p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in RULES}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) |\n|---|---|---|---|---|---|---|")
        for v in RULES:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} |", flush=True)
    b = out[(0.02, "tune", "champion")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max((v for v in RULES if v != "champion"), key=sc)
    bc, pc = out[(0.02, "check", "champion")], out[(0.02, "check", best)]
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
          f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}", flush=True)
    print("\n#### The main trades each version keeps, $10K at 2% returns: n, won, median, sum, giants (+300%), the rest; and the dropped trades' sum (giants)\n")
    print("| Version | Half | Fair kept | Fair dropped | Fav kept | Fav dropped |\n|---|---|---|---|---|---|")
    def desc(X):
        u = [1e4 * max(-1, r["v"]["champion"]["r"][0.02]) for r in X if "champion" in r["v"]]; g = [x for x in u if x >= 3e4]
        return f"{len(u)}, {sum(x > 0 for x in u)}, {st.median(u) if u else 0:+,.0f}, {sum(u):+,.0f}, {len(g)}, {sum(u) - sum(g):+,.0f}"
    def drop(X):
        u = [1e4 * max(-1, r["v"]["champion"]["r"][0.02]) for r in X if "champion" in r["v"]]
        return f"{len(u)}: {sum(u):+,.0f} ({sum(x >= 3e4 for x in u)})"
    for v in RULES:
        for part in ("tune", "check"):
            cells = []
            for src, a in L:
                base = [r for r in M if r["src"] == src and half(r["date"]) == part and r["date"] >= a]
                k = [r for r in base if keep(r, F, v)]
                cells += [desc(k), drop([r for r in base if not keep(r, F, v)])]
            print(f"| {v} | {part} | {' | '.join(cells)} |", flush=True)
    ranks = [f[0] for f in F.values()]
    print(f"\nThe champion's entries: rank 1 on {sum(x == 1 for x in ranks)} of {len(ranks)}, top 2 on {sum(x <= 2 for x in ranks)}; D2 best >= 2 on "
          f"{sum(f[1] >= 2 for f in F.values())}, >= 1.5 on {sum(f[1] >= 1.5 for f in F.values())}")
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/peer_rank_summary.json", "w"), indent=1)
    # the strategy alone (the user, 2026-10-30: "do not compare this to the champion for now ... show me benchmark only for
    # this strategy"): every entry (main + pyramid add) per version, half and list -> peer_rank_entries.json
    def ent(v, src, part, a):
        E = []
        for r in kept[v]:
            if r["src"] != src or half(r["date"]) != part or r["date"] < a or "champion" not in r["v"]: continue
            x = r["v"]["champion"]
            E.append(dict(date=r["date"], sym=r["sym"], right=r["right"], w=1.0, r={str(s): x["r"][s] for s in SIZES}, over=x["over"]))
            if not r["d2"]: continue
            for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= r["minute"] or "champion" not in ad["v"]: continue
                share, up = x["held"].get(ad["minute"], (0, None))
                if share > 0 and up is not None and up > 0:
                    E.append(dict(date=ad["date"], sym=r["sym"], right=r["right"], w=0.5, r={str(s): ad["v"]["champion"]["h"][s] for s in SIZES}, over=ad["v"]["champion"]["over"]))
                break
        return E
    json.dump({f"{v}|{src}|{p}": ent(v, src, p, a) for v in RULES for src, a in L for p in ("tune", "check")}, open(f"{B}/peer_rank_entries.json", "w"))
    # every main trade with the versions that keep it (giants_match.py: Indi's big winners caught and added)
    json.dump([dict(src=r["src"], date=r["date"], sym=r["sym"], right=r["right"], minute=r["minute"], half=half(r["date"]),
                    r2=r["v"]["champion"]["r"][0.02], keep=[v for v in RULES if keep(r, F, v)]) for r in M if "champion" in r["v"]],
              open(f"{B}/peer_rank_trades.json", "w"))


if __name__ == "__main__":
    main()
