"""The round strike one up or one down instead of a thin skip, on the champion 2.10 (the user, 2026-11-03: "I dont want
the nearest busy. Only one up and one down", after "Instead of 134 -> go to 135, instead of 247.5 go to 250"). When the
0.15-delta pick has under the floor in the last 30 minutes, look only at the two round strikes next to it: the
nearest round strike above and the nearest below (round = a whole dollar under a $25 stock, a multiple of $5 from $25
to $200, a multiple of $10 above $200, thin_strike.step_of); a pick that is itself round looks at the round ones on
either side. Of the two, the one with the floor's contracts and the $0.20 floor ($0.10 IBIT), nearer 0.15 delta; none
-> no trade. No delta cap. Set before running:
  champ   2.10 as is (thin_strike.py's champ)
  N200    the round neighbour needs 200 contracts (the pick's own floor stays 200)
  N150    the pick's floor and the neighbour's 150
Different from thin_strike.py's C150 (any round strike with delta 0.10-0.35 and 150, 2026-11-02, -33% / -51% on check)
and B (the next listed strike, any step). Added trades are fill unproven when under 200. Look 1.
Lists: the fair list + the Favorites (24 months); tune = even entry weeks, check = odd (split.py), the same run; one pick
on tune by min(fair, Favorites) vs champ at 2%; check for champ and the pick, at 2% and 3%.

  node --env-file=.env <dir>/run.mjs round_neighbor.py      (from the app repo root)
-> data/local/x/bt/round_neighbor_summary.json, round_neighbor_added.csv
"""
import collections, csv, json, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS
import sim
import fav_real as FR
import floor_exception as fe
import real_bench as RB

B = "data/local/x/bt"
TS.MODES = ("champ", "N200", "N150")
_pick = TS.pick


def neighbours(strike, step):
    q = strike / step
    lo = math.floor(q - 1e-9) if abs(q - round(q)) > 1e-6 else round(q) - 1
    hi = math.ceil(q + 1e-9) if abs(q - round(q)) > 1e-6 else round(q) + 1
    return lo * step, hi * step


def pick(cands, floor, mode, und, right, spot):
    if mode not in ("N200", "N150"): return _pick(cands, floor, mode, und, right, spot)
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    if best[4] < floor: return None
    need = 150 if mode == "N150" else 200
    if best[5] >= need: return best, "pick"
    near = neighbours(best[2], TS.step_of(spot))
    ok = [c for c in cands if any(abs(c[2] - k) < 1e-6 for k in near) and c[5] >= need and c[4] >= floor]
    return (min(ok, key=lambda c: abs(abs(c[3]) - 0.15)), "fb") if ok else None


TS.pick = pick


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(TS.one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    moved = [r for r in R if r["kind"] == "main" and "champ" not in r["v"]]
    print(f"{len(R)} rows; main signals with no champion trade but a neighbour trade: {len(moved)}", flush=True)
    out, rows = {}, []
    TS.table(R, adds, "tune", out, "Tune weeks (even)", TS.MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    pk = max(TS.MODES[1:], key=score)
    out["pick"] = pk
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs champ, 2%): {pk} ({score(pk):.3f}); better on both: {score(pk) > 1}")
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the pick only", ("champ", pk))
    TS.added(R, "tune", out, TS.MODES[1:], rows)
    TS.added(R, "check", out, (pk,), rows)
    fb = [r for r in R if r["kind"] == "main" for v in TS.MODES[1:] if r["pick"].get(v, {}).get("how") == "fb"]
    print(f"\nneighbour trades (main, all weeks, both versions): {len(fb)}")
    json.dump(out, open(f"{B}/round_neighbor_summary.json", "w"), indent=1)
    with open(f"{B}/round_neighbor_added.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
