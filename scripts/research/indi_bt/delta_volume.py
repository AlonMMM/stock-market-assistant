"""The busiest delta, on the champion 2.10 (the user, 2026-11-04: "I would like to choose the best delta. rule - you choose
the most volume delta from 0.1 (up to 0.09) to 0.2 (up to 0.22). if the chosen delta is <=0.15 - you can go with chip
option up to 0.1. try also with 0.2 as usual. let me k now number of trades."). Every signal re-picks its contract:
among 2.10's expiry's strikes (cheap_up.candidates' scan) with delta in the band, the one with the most contracts in
the last 30 minutes (a tie: the nearer 0.15). It still needs 200 in 30 minutes; the price floor is checked on the pick
(under it: no trade, as 2.10). Set before running:
  champ   2.10 as is (thin_strike.py's champ): the 0.15-delta strike, 200 contracts, $0.20 floor
  V10     band 0.09 - 0.22, the floor $0.10 when the pick's delta <= 0.15, else $0.20
  V20     band 0.09 - 0.22, the floor $0.20
  V10n / V20n   band 0.10 - 0.20 (neighbour)
  V10w / V20w   band 0.08 - 0.25 (neighbour)
IBIT keeps its $0.10 floor everywhere. Exits, size (0.5 / 1 / 1.5 by volume) and the pyramid as 2.10; the add re-picks
by the same rule. Real quotes, the real price paid (thin_strike.walk_c). Fair list + Favorites (24 months); tune = even
entry weeks, check = odd, in the same run; one pick per family (V10*, V20*) on tune by min(fair, Favorites) vs champ at
2%. Look 1 on this rule (the neighbours: oi_strike.py 2026-10-27, thin_strike.py 2026-11-02).

  node --env-file=.env <dir>/run.mjs delta_volume.py      (from the app repo root)
-> data/local/x/bt/delta_volume_summary.json, delta_volume_added.csv
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS   # sets 2.9's exits (via size_volume) before sim is imported
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half

B = "data/local/x/bt"
BANDS = {"": (0.09, 0.22), "n": (0.10, 0.20), "w": (0.08, 0.25)}
MODES = ("champ",) + tuple(f"V{f}{b}" for f in ("10", "20") for b in BANDS)
FAMILIES = {"V10": ("V10", "V10n", "V10w"), "V20": ("V20", "V20n", "V20w")}


def pick(cands, mode, und):
    """-> (candidate, why) ; candidate None when there is no trade (why: no_band / thin / cheap)."""
    lo, hi = BANDS[mode[3:]]
    band = [c for c in cands if lo <= abs(c[3]) <= hi]
    if not band: return None, "no_band"
    c = max(band, key=lambda c: (c[5], -abs(abs(c[3]) - 0.15)))
    if c[5] < 200: return None, "thin"
    floor = 0.20
    if und == "IBIT" or (mode.startswith("V10") and abs(c[3]) <= 0.15): floor = 0.10
    if c[4] < floor: return None, "cheap"
    return c, "ok"


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
               d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v={}, pick={}, why={})
    walked = {}
    for mode in MODES:
        if mode == "champ":
            p = TS.pick(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "champ", t["sym"], t["right"], spot)
            c, why = (p[0], "ok") if p else (None, "skip")
        else:
            c, why = pick(cands, mode, t["sym"])
        out["why"][mode] = why
        if c is None: continue
        if c[0] not in walked: walked[c[0]] = TS.walk_c(t, m0, c)
        if walked[c[0]] is None: out["why"][mode] = "no_walk"; continue
        out["v"][mode] = walked[c[0]]
        out["pick"][mode] = dict(contract=c[0], strike=c[2], delta=round(abs(c[3]), 3), price=c[4], vol30=c[5],
                                 book=int(bool(RB.quote(c[0], t["date"], m0 + 1))))
    return out


def counts(R, part, out):
    """The number of trades and what each rule picked (main legs, the user asked for the count)."""
    print(f"\n#### {part} weeks: main-leg trades and picks\n")
    print("| Version | List | Trades | Same contract as 2.10 | New trades (2.10 skips) | Lost (2.10 trades, not here) | Pick delta <= 0.15 | Pick under $0.20 | Pick delta p10 / median / p90 | No real book at the buy |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for v in MODES:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rs = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a]
            hit = [r for r in rs if v in r["v"]]
            champ = [r for r in rs if "champ" in r["v"]]
            same = sum(r["pick"][v]["contract"] == (r["pick"].get("champ") or {}).get("contract") for r in hit)
            new = sum("champ" not in r["v"] for r in hit)
            lost = sum(v not in r["v"] for r in champ)
            ds = sorted(r["pick"][v]["delta"] for r in hit) or [0]
            low = sum(r["pick"][v]["delta"] <= 0.15 for r in hit)
            cheap = sum(r["pick"][v]["price"] < 0.20 for r in hit)
            nobook = sum(not r["pick"][v]["book"] for r in hit)
            out[f"{part}|{v}|{src}|counts"] = dict(trades=len(hit), same=same, new=new, lost=lost, low=low, cheap=cheap, nobook=nobook)
            q = lambda p: ds[min(len(ds) - 1, int(p * len(ds)))]
            print(f"| {v} | {src} | {len(hit)} | {same} | {new} | {lost} | {low} | {cheap} | {q(0.1):.2f} / {q(0.5):.2f} / {q(0.9):.2f} | {nobook} |", flush=True)
    whys = collections.Counter((v, r["why"].get(v)) for r in R if r["kind"] == "main" and half(r["date"]) == part for v in MODES)
    print("  no-trade reasons (both lists): " + "; ".join(f"{v}: " + ", ".join(f"{w} {n}" for (vv, w), n in sorted(whys.items()) if vv == v and w != "ok") for v in MODES))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: R = pool.map(one, jobs, chunksize=4)
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out, rows = {}, []
    counts(R, "tune", out)
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    picks = {fam: max(vs, key=score) for fam, vs in FAMILIES.items()}
    out["picks"] = picks
    for fam, v in picks.items():
        print(f"\n🎯 {fam}: picked on tune (min of fair and Favorites vs champ, 2%): {v} ({score(v):.3f}); better on both: {score(v) > 1}")
    counts(R, "check", out)
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run (the verdict reads the 🎯 picks only)", MODES)
    TS.added(R, "tune", out, MODES[1:], rows)
    TS.added(R, "check", out, MODES[1:], rows)
    json.dump(out, open(f"{B}/delta_volume_summary.json", "w"), indent=1)
    import csv
    with open(f"{B}/delta_volume_added.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
