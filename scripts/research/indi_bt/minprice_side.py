"""The price floor and the side's option volume, on the champion 2.10 (the user, 2026-11-06: "can you test cheapest
limit 0.25? 0.3? you can exception stockes that are cost less that 30$ (their option must be cheeper)" and "I want to use
option volume as a filter, today we filter on the strike we decide - i think it not accourate, we need to decide on the
overall directional option volume"; then "I don't want to run it on the volume bot, but on the main bot"). Set before
running, every version is 2.10 (thin_strike.py champ) with one change:
  champ    2.10 as is: the 0.15-delta pick, $0.20 ($0.10 IBIT), 200 contracts in the last 30 minutes on the pick
  P25lo    the floor $0.25, a stock under $30 at the signal keeps $0.20
  P30lo    the floor $0.30, a stock under $30 keeps $0.20
  P30all   the floor $0.30 for every stock (IBIT keeps $0.10 in all)
  S1k / S3k / S10k   no 200 on the pick; the trade's side (the picker's OTM strikes of the expiry, cheap_up.candidates)
           traded >= 1,000 / 3,000 / 10,000 contracts in the 30 minutes before the signal
  R10 / R15  2.10's pick and 200 floor, and the trade's side traded >= 1.0x / 1.5x the other side's 30-minute volume
           (the same scan for the other right); no other-side bars = no trade, counted
One pick per idea (P / S / R) on tune by min(fair, Favorites) vs champ at 2%; check for champ and the picks only, at 2%
and 3%, the same run. S picks under 200 contracts are fill unproven. Look 1 for each idea.

  node --env-file=.env <dir>/run.mjs minprice_side.py      (from the app repo root)
-> data/local/x/bt/minprice_side_summary.json, minprice_side_added.csv
"""
import collections, csv, json, multiprocessing as mp, sys
import thin_strike as T
from thin_strike import sim, cu, fe, FR, SV, half

B = T.B
MODES = ("champ", "P25lo", "P30lo", "P30all", "S1k", "S3k", "S10k", "R10", "R15")
FAMILIES = {"P": ("P25lo", "P30lo", "P30all"), "S": ("S1k", "S3k", "S10k"), "R": ("R10", "R15")}
FLOOR = {"P25lo": (0.25, 0.20), "P30lo": (0.30, 0.20), "P30all": (0.30, 0.30)}
SIDE = {"S1k": 1000, "S3k": 3000, "S10k": 10000}
RATIO = {"R10": 1.0, "R15": 1.5}


def pick(cands, other, mode, sym, spot):
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    floor = 0.20
    if mode in FLOOR: floor = FLOOR[mode][0] if spot >= 30 else FLOOR[mode][1]
    if sym == "IBIT": floor = 0.10
    if best[4] < floor: return None
    side = sum(c[5] for c in cands)
    if mode in SIDE: return (best, "pick") if side >= SIDE[mode] else None
    if best[5] < 200: return None
    if mode in RATIO:
        if other is None: return None
        if side < RATIO[mode] * other: return None
    return best, "pick"


def one(job):
    src, kind, t = job
    if T.RB.DBX != T.fm.DBX[src]: T.RB.DBX = T.fm.DBX[src]; T.RB.Q.clear(); T.RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    oc = cu.candidates(t["sym"], t["date"], m0, "P" if t["right"] == "C" else "C", spot)
    other = sum(c[5] for c in oc) if oc else None
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], spot=spot,
               d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v={}, pick={},
               side=sum(c[5] for c in cands), other=other)
    walked = {}
    for mode in MODES:
        p = pick(cands, other, mode, t["sym"], spot)
        if not p: continue
        c, how = p
        if c[0] not in walked: walked[c[0]] = T.walk_c(t, m0, c)
        if walked[c[0]] is None: continue
        out["v"][mode] = walked[c[0]]
        out["pick"][mode] = dict(contract=c[0], strike=c[2], delta=round(abs(c[3]), 3), price=c[4], vol30=c[5], how=how)
    return out if out["v"] or kind == "main" else None


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", T.RB.LAST, flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    mains = [r for r in R if r["kind"] == "main"]
    champ = [r for r in mains if "champ" in r["v"]]
    print(f"{len(R)} rows; champion main trades {len(champ)}, of them with no other-side bars: "
          f"{sum(r['other'] is None for r in champ)}; other-side volume 0: {sum(r['other'] == 0 for r in champ)}", flush=True)
    R = [r for r in R if r["v"]]
    out, rows = {}, []
    T.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    picks = {fam: max(vs, key=score) for fam, vs in FAMILIES.items()}
    out["picks"] = picks
    for fam, v in picks.items():
        print(f"\n🎯 {fam}: picked on tune (min of fair and Favorites vs champ, 2%): {v} ({score(v):.3f}); better on both: {score(v) > 1}")
    T.table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the picks only", ("champ", *picks.values()))
    removed(R, out)
    T.added(R, "tune", out, MODES[1:], rows)
    T.added(R, "check", out, tuple(picks.values()), rows)
    json.dump(out, open(f"{B}/minprice_side_summary.json", "w"), indent=1)
    if rows:
        with open(f"{B}/minprice_side_added.csv", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


def removed(R, out):
    """The champion's main legs a version does not take: at $10K (r1 basis), median, sum, giants, non-giant sum."""
    import statistics as st
    print("\n#### The champion's trades each version drops (main legs at $10K)\n")
    print("| Part | Version | List | Dropped | Median | Sum | Giants | Non-giant sum |")
    print("|---|---|---|---|---|---|---|---|")
    for part in ("tune", "check"):
        for v in MODES[1:]:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                hit = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a
                       and "champ" in r["v"] and v not in r["v"]]
                usd = [1e4 * max(-1, r["v"]["champ"]["r1"]) for r in hit]
                g = [u for r, u in zip(hit, usd) if r["v"]["champ"]["r1"] >= 3.0]
                s = dict(n=len(hit), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)), giants=len(g),
                         nongiant=round(sum(usd) - sum(g)))
                out[f"{part}|{v}|{src}|dropped"] = s
                print(f"| {part} | {v} | {src} | {s['n']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} |", flush=True)


if __name__ == "__main__":
    main()
