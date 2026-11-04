"""Giants on 2.10's D2 entries and its pyramid adds (the user, 2026-11-04: "how many giants we have that relates the
double up or the pyramid?"). Analysis, not a rule. 2.10's trades as thin_strike.py's champ walks them (the 0.15 pick,
200 contracts, $0.20 floor, 2.9's exits, real quotes): main legs split into D2 (c_t < 1.8, the bonus entry; only these
can add) and the rest; the pyramid add = the first add signal after the main entry while it is held and up (half size,
the leg's own return). Per list and half: count, winners, giants (+300% at the 1% basis), median and sum at $10K (the add
at its own $10K, not halved), and how many main giants had an add, and how many adds are on a main giant.

  node --env-file=.env <dir>/run.mjs pyramid_giants.py      (from the app repo root)
"""
import collections, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    p = TS.pick(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "champ", t["sym"], t["right"], spot)
    if not p: return None
    x = TS.walk_c(t, m0, p[0])
    if x is None: return None
    return dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), r1=x["r1"], held=x["held"])


def grp(rows):
    usd = [1e4 * max(-1, r["r1"]) for r in rows]
    g = sum(r["r1"] >= 3 for r in rows)
    w = sum(u > 0 for u in usd)
    n = max(1, len(rows))
    return f"{len(rows)} | {w} ({w / n:.0%}) | {g} ({g / n:.1%}) | {st.median(usd) if usd else 0:+,.0f} | {sum(usd):+,.0f}"


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25") if t["date"] >= FR.A24] + [("fav", "add", t) for t in FR.signals("24") if t["date"] >= FR.A24]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    print("\n| List | Half | Group | Trades | Winners | Giants (+300%) | Median at $10K | Sum at $10K |")
    print("|---|---|---|---|---|---|---|---|")
    for src in ("fair", "fav"):
        for part in ("tune", "check"):
            mains = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part]
            taken = []
            for r in mains:
                if not r["d2"]: continue
                for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
                    if ad["minute"] <= r["minute"]: continue
                    share, up = r["held"].get(ad["minute"], (0, None))
                    if share > 0 and up is not None and up > 0: taken.append((r, ad))
                    break
            d2 = [r for r in mains if r["d2"]]
            for name, rows in (("all main legs", mains), ("main, not D2", [r for r in mains if not r["d2"]]),
                               ("main, D2", d2), ("main, D2 with an add", [m for m, _ in taken]),
                               ("the pyramid adds", [a for _, a in taken])):
                print(f"| {src} | {part} | {name} | {grp(rows)} |", flush=True)
            both = sum(m["r1"] >= 3 and a["r1"] >= 3 for m, a in taken)
            print(f"| {src} | {part} | main giant and its add a giant | {both} | | | | |", flush=True)


if __name__ == "__main__":
    main()
