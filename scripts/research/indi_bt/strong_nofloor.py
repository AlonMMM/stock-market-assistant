"""No volume floor for the strongest signals only, on the champion 2.10 (the user, 2026-11-03: "what about if we trade
without flow or with smaller flow, only the top percent of the alerts, for example, high volume and high T and D2,
something that we double most of the time"). A 0.15-delta pick under 200 contracts in 30 minutes is bought (the same
contract, the $0.20 floor, $0.10 IBIT) only when the signal is strong; picks with 200+ unchanged; 2.10's exits, size
(t3A by c_rvol) and pyramid (the add uses the same rule on its own signal). Levels set before running from the signal
distributions (fair / Favorites main signals): t top 20% = 2.3, the stock's volume = 2.10's top tier 2.5x (~top 7%),
D2 = an entry through the D2 bonus (t < 1.8, a third of signals; so "high t and D2" cannot both hold):
  champ   2.10 as is
  RV      thin bought when c_rvol >= 2.5
  T       thin bought when c_t >= 2.3
  D2      thin bought on a D2 entry
  RVT     c_rvol >= 2.5 and c_t >= 2.3
  RVD2    c_rvol >= 2.5 and a D2 entry
  RVT50   RVT, the pick still needs 50 contracts
Tested before as "D2 under 200" (d2_liquid.py, 2026-10-25, 2.5, the old walk and the bar fills): big on the fair list,
lost on the unseen; never on real quotes, the fixed walk or tune / check. Added thin trades are fill unproven. Look 1.
Lists: the fair list + the Favorites (24 months); tune = even entry weeks, check = odd (split.py), the same run; one pick
on tune by min(fair, Favorites) vs champ at 2%; check for champ and the pick, at 2% and 3%.

  node --env-file=.env <dir>/run.mjs strong_nofloor.py      (from the app repo root)
-> data/local/x/bt/strong_nofloor_summary.json, strong_nofloor_trades.csv
"""
import bisect, collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half

B = "data/local/x/bt"
MODES = ("champ", "RV", "T", "D2", "RVT", "RVD2", "RVT50")
T_HI, RV_HI = 2.3, 2.5
LOOKBACK, MIN_N = 30, 5


def first(job):
    """Pass 1: the 0.15 pick of every signal (no walk)."""
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    if best[4] < floor: return None
    return job, best


def usual_table(P):
    """sym -> sorted [(date, vol30)] of main picks, one per signal (lists pooled)."""
    seen, by = set(), collections.defaultdict(list)
    for (src, kind, t), best in P:
        k = (t["sym"], t["date"], int(t["minute"]), t["right"])
        if kind != "main" or k in seen: continue
        seen.add(k); by[t["sym"]].append((t["date"], best[5]))
    return {s: sorted(v) for s, v in by.items()}


def ratio(U, sym, date, vol):
    xs = U.get(sym, [])
    i = bisect.bisect_left(xs, (date, -1))
    prior = [v for _, v in xs[max(0, i - LOOKBACK):i]]
    if len(prior) < MIN_N: return None, None
    usual = st.median(prior)
    return (vol / usual if usual > 0 else 99.0), usual


def takes(vol, t, rv):
    if vol >= 200: return list(MODES)
    d2, hi_t, hi_v = t < 1.8, t >= T_HI, rv >= RV_HI
    ok = dict(RV=hi_v, T=hi_t, D2=d2, RVT=hi_v and hi_t, RVD2=hi_v and d2, RVT50=hi_v and hi_t and vol >= 50)
    return [v for v in MODES[1:] if ok[v]]


def second(job):
    """Pass 2: the walk, for the signals some version buys."""
    (src, kind, t), best, r, usual = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    take = takes(best[5], float(t.get("c_t") or 9), float(t.get("c_rvol") or 0))
    if not take: return None
    m0 = int(t["minute"])
    row = TS.walk_c(t, m0, best)
    if row is None: return None
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
               d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v={}, pick={})
    info = dict(contract=best[0], delta=round(abs(best[3]), 3), price=best[4], vol30=best[5],
                ratio=None if r is None else round(r, 2), usual=usual)
    for v in take: out["v"][v] = row; out["pick"][v] = info
    return out


def diff(R, part, out, versions, rows_out):
    print(f"\n#### {part} weeks: the main trades each version added / dropped vs champ (at $10K; added = fill unproven)\n")
    print("| Version | List | Added | Median | Sum | Giants | Non-giant sum | Ratio median | Vol30 median | Dropped | Dropped sum · giants | By year (added) | Top added |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for v in versions:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            base = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a]
            hit = [r for r in base if v in r["v"] and "champ" not in r["v"]]
            drop = [r for r in base if "champ" in r["v"] and v not in r["v"]]
            usd = [1e4 * max(-1, r["v"][v]["r1"]) for r in hit]
            dusd = [1e4 * max(-1, r["v"]["champ"]["r1"]) for r in drop]
            g = [u for r, u in zip(hit, usd) if r["v"][v]["r1"] >= 3.0]
            years, names = collections.defaultdict(float), collections.defaultdict(float)
            for r, u in zip(hit, usd): years[r["date"][:4]] += u; names[r["sym"]] += u
            rs = [r["pick"][v]["ratio"] for r in hit if r["pick"][v]["ratio"] is not None]
            s = dict(n=len(hit), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)), giants=len(g),
                     nongiant=round(sum(usd) - sum(g)), ratio_median=round(st.median(rs), 2) if rs else None,
                     vol_median=st.median(r["pick"][v]["vol30"] for r in hit) if hit else None,
                     dropped=len(drop), dropped_sum=round(sum(dusd)), dropped_giants=sum(r["v"]["champ"]["r1"] >= 3 for r in drop),
                     years={y: round(x) for y, x in sorted(years.items())},
                     top=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: -kv[1])[:4]])
            out[f"{part}|{v}|{src}|diff"] = s
            yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
            print(f"| {v} | {src} | {s['n']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} | {s['ratio_median']} | {s['vol_median']} | {s['dropped']} | {s['dropped_sum']:+,} · {s['dropped_giants']} | {yrs} | {', '.join(s['top'])} |", flush=True)
            for r, u in zip(hit, usd):
                p = r["pick"][v]
                rows_out.append(dict(part=part, version=v, list=src, kind="added", date=r["date"], minute=r["minute"], sym=r["sym"],
                                     right=r["right"], contract=p["contract"], delta=p["delta"], price=p["price"], vol30=p["vol30"],
                                     usual=p["usual"], ratio=p["ratio"], usd10k=round(u)))
            for r, u in zip(drop, dusd):
                p = r["pick"]["champ"]
                rows_out.append(dict(part=part, version=v, list=src, kind="dropped", date=r["date"], minute=r["minute"], sym=r["sym"],
                                     right=r["right"], contract=p["contract"], delta=p["delta"], price=p["price"], vol30=p["vol30"],
                                     usual=p["usual"], ratio=p["ratio"], usd10k=round(u)))


def buckets(R):
    """Giant rate by ratio, every main pick that champ or a version walked (both lists, all weeks)."""
    print("\n#### Main picks by ratio (walked ones; giants = +300%)\n")
    print("| Ratio | List | Trades | Giants | Rate | Median | Vol30 median |")
    print("|---|---|---|---|---|---|---|")
    for src, a in (("fair", ""), ("fav", FR.A24)):
        x = [r for r in R if r["src"] == src and r["kind"] == "main" and r["date"] >= a]
        for lo, hi in ((0, .5), (.5, 1), (1, 2), (2, 3), (3, 5), (5, 1e9)):
            b = [r for r in x if r["pick"][next(iter(r["pick"]))]["ratio"] is not None and lo <= r["pick"][next(iter(r["pick"]))]["ratio"] < hi]
            if not b: continue
            rr = [max(-1, r["v"][next(iter(r["v"]))]["r1"]) for r in b]
            print(f"| {lo}-{hi if hi < 1e9 else '+'} | {src} | {len(b)} | {sum(q >= 3 for q in rr)} | {sum(q >= 3 for q in rr) / len(b):.1%} | {st.median(rr):+.0%} | {st.median(r['pick'][next(iter(r['pick']))]['vol30'] for r in b)} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: P = [p for p in pool.map(first, jobs, chunksize=4) if p]
    U = usual_table(P)
    J = []
    for job, best in P:
        r, usual = ratio(U, job[2]["sym"], job[2]["date"], best[5])
        J.append((job, best, r, usual))
    print(f"{len(P)} picks; with a ratio: {sum(j[2] is not None for j in J)}", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(second, J, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out, rows = {}, []
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    pick = max(MODES[1:], key=score)
    out["pick"] = pick
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs champ, 2%): {pick} ({score(pick):.3f}); better on both: {score(pick) > 1}")
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the pick only", ("champ", pick))
    diff(R, "tune", out, MODES[1:], rows)
    diff(R, "check", out, (pick,), rows)
    json.dump(out, open(f"{B}/strong_nofloor_summary.json", "w"), indent=1)
    with open(f"{B}/strong_nofloor_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
