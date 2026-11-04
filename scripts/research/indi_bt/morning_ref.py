"""The morning rule measured from yesterday's close at the decision, not at the open (the user, 2026-11-04, on AAPL
2024-06-12: the stock opened +0.1% over the close, so 2.10 sold all at 09:40, then ran to +6%: "So only if the gap is in
our way from the openning we are sold 50%? This is weird. First 0.5% might be differ from stocks but lets say it fine.
Second we need it to be up from yesterdat close"). Built on 2.10 (sale_limit.py bid-c5 = size_volume t3A-c5: entries,
picks, exits, sizing, the pyramid, real quotes, the real price paid). Only the first carried morning's rule changes
(sim.py gap_ref); at 09:40 it keeps half when the stock is our way by:
  open-05   the open vs yesterday's close >= 0.5%                       (2.10 as is)
  now-05    the stock at 09:40 vs yesterday's close >= 0.5%              (the user's)
  now-0     the same, >= 0% (any up)                                     (a neighbour)
  either-05 the open or 09:40 vs yesterday's close >= 0.5%                (a neighbour)
Yesterday's close = the 16:00 close (the store holds the regular session only; post-market prints are not in it).
Tune = even weeks, check = odd (split.py), the same run; one pick on tune by min(fair, Favorites) vs 2.10 at 2%; only
the pick on check.

  node --env-file=.env <dir>/run.mjs morning_ref.py      (from the app repo root)
-> data/local/x/bt/morning_ref_summary.json
"""
import collections, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sale_limit as SL
SL.MODES = ("bid-c5",)
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
import size_volume as SV
from d2_failed_break import CHAMP

B = "data/local/x/bt"
VERS = {"open-05-c5": dict(gap_ref="open", gap_keep=0.5), "now-05-c5": dict(gap_ref="now", gap_keep=0.5),
        "now-0-c5": dict(gap_ref="now", gap_keep=0.0), "either-05-c5": dict(gap_ref="either", gap_keep=0.5)}
BASE = "open-05-c5"
for v in VERS: SV.SIZEV[v] = SV.SIZEV["t3A-c5"]


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    rows = {}
    for v, x in VERS.items():
        SL.CHAMP = {**CHAMP, **x}
        got = SL.walk_modes(t, m0, float(t["price"]))
        if got: rows[v] = got[0]["bid-c5"]
    if not rows: return None
    return dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v=rows, at={v: m0 for v in rows})


def table(R, adds, part, versions, out, title):
    for size in (0.02, 0.03):
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | vs 2.10 | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in versions:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(SV.entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                b = out.get(f"{part}|{BASE}|{src}|{size}", s)["acct"]
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | {s['acct'] / b:.3f} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)


def changed(R, part, v):
    """The main legs whose result v changes vs 2.10, fair list, at $10K (2% returns): count, sum vs 2.10's, giants, median of the change."""
    import statistics as st
    from split import half
    ch = [(r["v"][v]["r2"], r["v"][BASE]["r2"]) for r in R if r["kind"] == "main" and r["src"] == "fair" and half(r["date"]) == part
          and v in r["v"] and BASE in r["v"] and abs(r["v"][v]["r2"] - r["v"][BASE]["r2"]) > 1e-9]
    d = [1e4 * (max(-1, a) - max(-1, b)) for a, b in ch]
    return f"{len(ch)} trades; {sum(1e4 * max(-1, a) for a, _ in ch):+,.0f} vs {sum(1e4 * max(-1, b) for _, b in ch):+,.0f}; median change {st.median(d) if d else 0:+,.0f}; better {sum(x > 0 for x in d)}, worse {sum(x < 0 for x in d)}"


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", tuple(VERS), out, "Tune weeks (even)")
    print("\n#### The trades each version changes (fair list, main legs, 2% returns at $10K)\n\n| Version | Tune |\n|---|---|")
    for v in list(VERS)[1:]: print(f"| {v} | {changed(R, 'tune', v)} |", flush=True)
    score = lambda v: min(out[f"tune|{v}|{s}|0.02"]["acct"] / out[f"tune|{BASE}|{s}|0.02"]["acct"] for s in ("fair", "fav"))
    best = max(list(VERS)[1:], key=score)
    out["best"] = best
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs 2.10, 2%): {best} ({score(best):.3f}); better on both: {score(best) > 1}", flush=True)
    table(R, adds, "check", (BASE, best), out, "Check weeks (odd), the same run")
    print(f"\n| {best}, check | {changed(R, 'check', best)} |", flush=True)
    json.dump(out, open(f"{B}/morning_ref_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
