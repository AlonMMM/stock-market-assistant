"""A busy neighbour lets the thin pick trade, on the champion 2.10 (the user, 2026-11-03: "Another test - I would like to
check if there is a big volume neiber- trade with the original option"). When the 0.15-delta pick has under 200
contracts in the last 30 minutes, buy that same pick anyway when a strike next to it (same expiry and side) is busy;
the neighbour is only a gate, the contract does not change. The $0.20 floor ($0.10 IBIT), 2.10's exits, size and
pyramid (the add uses the same rule with its own pick). Set before running:
  champ    2.10 as is (thin_strike.py's champ)
  A200     the listed strike one up or one down from the pick (the next in the chain, any step) has 200+ in 30 minutes
  A500     the same with 500+
  R200     the round strike one up or one down (round_neighbor.neighbours on thin_strike.step_of) has 200+
  A200f50  A200, and the pick itself needs 50+
A neighbour outside the picker's scan (cheap_up.candidates' max_strikes) gets its volume the same way, from its minute
bars (minute - 30 < m <= minute); a strike with no bars counts 0. Different from round_neighbor.py (2026-11-03) and
thin_strike.py's B / C150 (2026-11-02), which bought the neighbour, and oi_strike.py (chose by OI). Added trades are
"fill unproven" (a thin contract). Look 1.
Lists: the fair list + the Favorites (24 months); tune = even entry weeks, check = odd (split.py), the same run; one pick
on tune by min(fair, Favorites) vs champ at 2%; check for champ and the pick, at 2% and 3%.

  node --env-file=.env <dir>/run.mjs neighbor_gate.py      (from the app repo root)
-> data/local/x/bt/neighbor_gate_summary.json, neighbor_gate_added.csv
"""
import collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half
from store import day

B = "data/local/x/bt"
MODES = ("champ", "A200", "A500", "R200", "A200f50")


def neighbours(strike, step):
    """round_neighbor.neighbours (not imported: that module patches thin_strike on import)."""
    q = strike / step
    lo = int(q - 1e-9) if abs(q - round(q)) > 1e-6 else round(q) - 1
    hi = -int(-(q + 1e-9)) if abs(q - round(q)) > 1e-6 else round(q) + 1
    return lo * step, hi * step


def vol30(und, exp, k, right, date, minute, cands):
    """-> (contracts in the 30 minutes, in the scan)."""
    for c in cands:
        if abs(c[2] - k) < 1e-6: return c[5], True
    return sum(y[5] for y in day(sim.occ(und, exp, k, right), date) if minute - 30 < y[0] <= minute), False


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    if best[4] < floor: return None
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
               d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v={}, pick={})
    info = dict(contract=best[0], strike=best[2], delta=round(abs(best[3]), 3), price=best[4], vol30=best[5])
    if best[5] >= 200:
        take = list(MODES)
    else:
        ks = sorted(sim.chain(t["sym"], best[1], t["right"]))
        i = ks.index(best[2])
        adj = [ks[j] for j in (i - 1, i + 1) if 0 <= j < len(ks)]
        rnd = [k for k in neighbours(best[2], TS.step_of(spot)) if any(abs(k - x) < 1e-6 for x in ks)]
        A = [(k, *vol30(t["sym"], best[1], k, t["right"], t["date"], m0, cands)) for k in adj]
        R = [(k, *vol30(t["sym"], best[1], k, t["right"], t["date"], m0, cands)) for k in rnd]
        topA = max(A, key=lambda x: x[1], default=(None, 0, True))
        topR = max(R, key=lambda x: x[1], default=(None, 0, True))
        take, gate = [], {}
        if topA[1] >= 200: take.append("A200"); gate["A200"] = topA
        if topA[1] >= 500: take.append("A500"); gate["A500"] = topA
        if topR[1] >= 200: take.append("R200"); gate["R200"] = topR
        if topA[1] >= 200 and best[5] >= 50: take.append("A200f50"); gate["A200f50"] = topA
        if not take: return None
    row = TS.walk_c(t, m0, best)
    if row is None: return None
    for v in take:
        out["v"][v] = row
        g = gate.get(v) if best[5] < 200 else None
        out["pick"][v] = dict(info, how="pick" if g is None else "gate", nb_strike=None if g is None else g[0],
                              nb_vol=None if g is None else g[1], nb_inscan=None if g is None else g[2])
    return out


def added(R, part, out, versions, rows_out):
    print(f"\n#### {part} weeks: the main trades each version added (the thin pick bought on a busy neighbour, at $10K; all fill unproven)\n")
    print("| Version | List | Added | Winners | Median | Sum | Giants | Non-giant sum | Without their best 5 | Pick vol30 median | Neighbour vol30 median | Out of scan | By year | Top names |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for v in versions:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            hit = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a
                   and v in r["v"] and "champ" not in r["v"]]
            usd = [1e4 * max(-1, r["v"][v]["r1"]) for r in hit]
            g = [u for r, u in zip(hit, usd) if r["v"][v]["r1"] >= 3.0]
            years, names = collections.defaultdict(float), collections.defaultdict(float)
            for r, u in zip(hit, usd): years[r["date"][:4]] += u; names[r["sym"]] += u
            s = dict(n=len(hit), win=sum(u > 0 for u in usd), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)),
                     giants=len(g), nongiant=round(sum(usd) - sum(g)), no5=round(sum(sorted(usd)[:-5])) if len(usd) > 5 else 0,
                     pick_vol=st.median(r["pick"][v]["vol30"] for r in hit) if hit else None,
                     nb_vol=st.median(r["pick"][v]["nb_vol"] for r in hit) if hit else None,
                     out_scan=sum(not r["pick"][v]["nb_inscan"] for r in hit),
                     years={y: round(x) for y, x in sorted(years.items())},
                     top=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: -kv[1])[:4]],
                     bottom=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: kv[1])[:3]])
            out[f"{part}|{v}|{src}|added"] = s
            yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
            print(f"| {v} | {src} | {s['n']} | {s['win']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} | {s['no5']:+,} | {s['pick_vol']} | {s['nb_vol']} | {s['out_scan']} | {yrs} | {', '.join(s['top'])}; worst {', '.join(s['bottom'])} |", flush=True)
            for r, u in zip(hit, usd):
                p = r["pick"][v]
                rows_out.append(dict(part=part, version=v, list=src, date=r["date"], minute=r["minute"], sym=r["sym"], right=r["right"],
                                     contract=p["contract"], strike=p["strike"], delta=p["delta"], price=p["price"], vol30=p["vol30"],
                                     nb_strike=p["nb_strike"], nb_vol30=p["nb_vol"], nb_inscan=int(bool(p["nb_inscan"])), usd10k=round(u)))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    gated = [r for r in R if r["kind"] == "main" and "champ" not in r["v"]]
    print(f"{len(R)} rows; main signals bought only on a busy neighbour: {len(gated)}; "
          f"of the gates, neighbour outside the scan: {sum(1 for r in gated for p in r['pick'].values() if not p['nb_inscan'])}", flush=True)
    out, rows = {}, []
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    pk = max(MODES[1:], key=score)
    out["pick"] = pk
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs champ, 2%): {pk} ({score(pk):.3f}); better on both: {score(pk) > 1}")
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the pick only", ("champ", pk))
    added(R, "tune", out, MODES[1:], rows)
    added(R, "check", out, (pk,), rows)
    json.dump(out, open(f"{B}/neighbor_gate_summary.json", "w"), indent=1)
    with open(f"{B}/neighbor_gate_added.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
