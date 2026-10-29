"""SPY against the bot's positions (the user, 2026-10-29, after spy_drag.py: "check that, maybe we can try to take edge
only there?" and "cutting some from the big winners when we see the spy goes down more than -.5%").

On the champion of retry_roll.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes). Set before running:
  A. analysis   every night the champion holds: SPY's move over the last 30 / 60 minutes to the 15:50 decision, on the
                trade's side, against the SPY gap to 09:40 and the night's option move (buckets, by half)
     night rule (sim.py carry_spy): at a 15:50 hold, when SPY moved against the bet by X over the last W minutes, hold
                only `keep` tonight (the rest sold at the 15:50 bid)
       ny-60-30    W 60, X 0.3%, keep 0 (no night)       ny-60-50   W 60, X 0.5%, keep 0
       ny-30-30    W 30, X 0.3%, keep 0                   ny-60-30h  W 60, X 0.3%, keep half
  B. big-winner cut (sim.py spy_cut): once the option was up `arm`, when SPY falls `drop` against the bet from its best
     since then (any day, gaps included), sell `share` of what is left, once
       cut-100-50   arm +100%, drop 0.5%, half (the thesis)
       cut-50-50    +50%      cut-200-50   +200%      cut-100-30   drop 0.3%      cut-100-50t   a third
One run, tune AND check (split.py), fair list + Favorites (favorites.txt, 24 months), 2% and 3%, each idea picked on
tune by min(fair, Favorites) money; the giants, the median and the rest of the changed trades.

  node --env-file=.env <dir>/run.mjs spy_rules.py      (from the app repo root)
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
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
from store import day

B = "data/local/x/bt"
SIZES = rr.SIZES
VERSIONS = {"champion": CHAMP,
            "ny-60-30": {**CHAMP, "carry_spy": {"window": 60, "against": 0.003, "keep": 0.0}},
            "ny-60-50": {**CHAMP, "carry_spy": {"window": 60, "against": 0.005, "keep": 0.0}},
            "ny-30-30": {**CHAMP, "carry_spy": {"window": 30, "against": 0.003, "keep": 0.0}},
            "ny-60-30h": {**CHAMP, "carry_spy": {"window": 60, "against": 0.003, "keep": 0.5}},
            "cut-100-50": {**CHAMP, "spy_cut": {"arm": 1.0, "drop": 0.005, "share": 0.5}},
            "cut-50-50": {**CHAMP, "spy_cut": {"arm": 0.5, "drop": 0.005, "share": 0.5}},
            "cut-200-50": {**CHAMP, "spy_cut": {"arm": 2.0, "drop": 0.005, "share": 0.5}},
            "cut-100-30": {**CHAMP, "spy_cut": {"arm": 1.0, "drop": 0.003, "share": 0.5}},
            "cut-100-50t": {**CHAMP, "spy_cut": {"arm": 1.0, "drop": 0.005, "share": 1 / 3}}}
IDEAS = (("A. Skip / halve the night when SPY weakens into the close", ("ny-60-30", "ny-60-50", "ny-30-30", "ny-60-30h")),
         ("B. Cut part of a big winner when SPY drops", ("cut-100-50", "cut-50-50", "cut-200-50", "cut-100-30", "cut-100-50t")))


def spy_at(d, m):
    c = rr.closes("SPY", d)
    for k in range(min(m, 389), -1, -1):
        if c[k]: return c[k]
    return None


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    bet = 1 if right == "C" else -1
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8), v={}, nights=[])
    for v, ex in VERSIONS.items():
        if kind == "add" and v != "champion": continue
        g = rr.leg(sym, date, m0, right, c, ex)
        if not g: continue
        rcost, real, _ = g
        sells = [s for s in real if s[2] == "sell"]
        r = dict(r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                 over=int(any(s[0] != date for s in sells)), exits=collections.Counter(s[5] for s in sells))
        if kind == "main":
            held = {}
            for mm in range(m0, 390):
                q = RB.quote(c[0], date, mm)
                held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
            r["held"] = held
            if v == "champion":   # A's analysis: each night held
                for s in real:
                    if s[2] != "carry": continue
                    nd = rr.CAL[rr.CAL.index(s[0]) + 1]
                    a60, a30, a0, gap = spy_at(s[0], s[1] - 60), spy_at(s[0], s[1] - 30), spy_at(s[0], s[1]), spy_at(nd, 10)
                    ob = [x for x in day(c[0], nd) if x[0] <= 10]
                    if a60 and a30 and a0 and gap and ob:
                        out["nights"].append(dict(half=half(date), last60=bet * (a0 / a60 - 1), last30=bet * (a0 / a30 - 1), gap=bet * (gap / a0 - 1),
                                                  night=ob[-1][4] / s[4] - 1, units=s[3] * s[4] / rcost))
        out["v"][v] = r
    return out


def entries(R, adds, src, v, part, size, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x = r["v"][v]
        E.append((r["date"], r["minute"], 1.0, x["r"][size], x["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"] or "champion" not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["v"]["champion"]["h"][size], ad["v"]["champion"]["over"]))
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
    M = [r for r in R if r["kind"] == "main"]
    # A. the analysis: SPY into the close vs the night
    for src, a in (("fair", ""), ("fav", FR.A24)):
        N = [n for r in M if r["src"] == src and r["date"] >= a for n in r["nights"]]
        for key, lab in (("last60", "SPY's last 60 minutes to 15:50"), ("last30", "SPY's last 30 minutes")):
            print(f"\n#### {src}: {lab}, on the trade's side -> the overnight gap and the night (15:50 -> 09:40), $ at $10K\n\n| Bucket | Half | Nights | SPY gap against (share) | Median gap | Nights won | Median night | Sum |\n|---|---|---|---|---|---|---|---|")
            for bl, f in (("against >= 0.3%", lambda x: x <= -0.003), ("against 0-0.3%", lambda x: -0.003 < x < 0), ("with 0-0.3%", lambda x: 0 <= x < 0.003), ("with >= 0.3%", lambda x: x >= 0.003)):
                for part in ("tune", "check"):
                    Y = [n for n in N if n["half"] == part and f(n[key])]
                    if not Y: continue
                    print(f"| {bl} | {part} | {len(Y)} | {sum(n['gap'] < 0 for n in Y) / len(Y):.0%} | {st.median(n['gap'] for n in Y):+.2%} | {sum(n['night'] > 0 for n in Y)} | "
                          f"{st.median(n['night'] for n in Y):+.0%} | {sum(1e4 * n['units'] * n['night'] for n in Y):+,.0f} |", flush=True)
    L = (("fair", ""), ("fav", FR.A24))
    out = {(s, p, v): [rr.stats(entries(R, adds, src, v, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in VERSIONS}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) |\n|---|---|---|---|---|---|---|")
        for v in VERSIONS:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} |", flush=True)
    b = out[(0.02, "tune", "champion")]
    for name, group in IDEAS:
        sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
        best = max(group, key=sc)
        bc, pc = out[(0.02, "check", "champion")], out[(0.02, "check", best)]
        print(f"\nPicked on tune ({name}): {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
              f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}", flush=True)
    print("\n#### The trades each version changes (fair list), $10K at 2% returns: count; this version vs the champion; giants (this / champion); median change\n\n| Version | Tune | Check |\n|---|---|---|")
    for v in VERSIONS:
        if v == "champion": continue
        cells = []
        for part in ("tune", "check"):
            ch = [(r["v"][v]["r"][0.02], r["v"]["champion"]["r"][0.02]) for r in M if r["src"] == "fair" and half(r["date"]) == part
                  and v in r["v"] and "champion" in r["v"] and abs(r["v"][v]["r"][0.02] - r["v"]["champion"]["r"][0.02]) > 1e-6]
            a = [1e4 * max(-1, x) for x, _ in ch]; c0 = [1e4 * max(-1, y) for _, y in ch]
            cells.append(f"{len(ch)}; {sum(a):+,.0f} vs {sum(c0):+,.0f}; giants {sum(x >= 3e4 for x in a)} / {sum(y >= 3e4 for y in c0)}; median change {st.median(x - y for x, y in zip(a, c0)) if ch else 0:+,.0f}")
        print(f"| {v} | {cells[0]} | {cells[1]} |", flush=True)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/spy_rules_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
