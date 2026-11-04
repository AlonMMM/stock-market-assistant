"""The busiest delta, only on 2.10's own trades (the user, 2026-11-04, after delta_volume.py: "can you do the same but -
only when the origin have more then 2 floor do the trade (expect no extra trade)"). A signal trades only when 2.10's
0.15-delta pick passes both of 2.10's floors (200 contracts in 30 minutes, the $0.20 price; IBIT $0.10); then the
contract is delta_volume.py's busiest strike in the band instead. If that strike is under its own price floor, 2.10's
0.15 strike is bought, so the trades are 2.10's, one for one. Set before running:
  champ        2.10 as is
  G10 / G20    band 0.09 - 0.22; G10: the floor $0.10 when the busiest strike's delta <= 0.15, else $0.20; G20: $0.20
  G10n / G20n  band 0.10 - 0.20;  G10w / G20w  band 0.08 - 0.25 (neighbours)
2.10's exits, size and pyramid; the add follows the same rule. Real quotes, the real price paid. Fair list + Favorites
(24 months); tune = even weeks, check = odd, in the same run; one pick per family on tune by min(fair, Favorites) vs
champ at 2%. Look 2 on the busiest delta (delta_volume.py's run showed its moved-strike trades on both halves).

  node --env-file=.env <dir>/run.mjs delta_volume_gated.py      (from the app repo root)
-> data/local/x/bt/delta_volume_gated_summary.json, delta_volume_gated_added.csv
"""
import collections, csv, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS
import delta_volume as DV
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB

B = "data/local/x/bt"
MODES = ("champ",) + tuple(f"G{f}{b}" for f in ("10", "20") for b in DV.BANDS)
FAMILIES = {"G10": ("G10", "G10n", "G10w"), "G20": ("G20", "G20n", "G20w")}


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
               d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v={}, pick={}, why={})
    p0 = TS.pick(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "champ", t["sym"], t["right"], spot)
    if not p0: return out
    c0 = p0[0]
    walked = {}
    for mode in MODES:
        c, why = c0, "ok"
        if mode != "champ":
            c, why = DV.pick(cands, "V" + mode[1:], t["sym"])
            if c is None: c, why = c0, "kept_" + why
        out["why"][mode] = why
        if c[0] not in walked: walked[c[0]] = TS.walk_c(t, m0, c)
        if walked[c[0]] is None: out["why"][mode] = "no_walk"; continue
        out["v"][mode] = walked[c[0]]
        out["pick"][mode] = dict(contract=c[0], strike=c[2], delta=round(abs(c[3]), 3), price=c[4], vol30=c[5],
                                 book=int(bool(RB.quote(c[0], t["date"], m0 + 1))))
    return out


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: R = pool.map(one, jobs, chunksize=4)
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    DV.MODES = MODES
    out, rows = {}, []
    DV.counts(R, "tune", out)
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    picks = {fam: max(vs, key=score) for fam, vs in FAMILIES.items()}
    out["picks"] = picks
    for fam, v in picks.items():
        print(f"\n🎯 {fam}: picked on tune (min of fair and Favorites vs champ, 2%): {v} ({score(v):.3f}); better on both: {score(v) > 1}")
    DV.counts(R, "check", out)
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run (the verdict reads the 🎯 picks only)", MODES)
    TS.added(R, "tune", out, MODES[1:], rows)
    TS.added(R, "check", out, MODES[1:], rows)
    json.dump(out, open(f"{B}/delta_volume_gated_summary.json", "w"), indent=1)
    with open(f"{B}/delta_volume_gated_added.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
