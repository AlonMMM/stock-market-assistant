"""Winners and giants among the signals 2.10 skips for a floor (the user, 2026-11-04, after "what is the percentage of
winners and the giants now?": "in the filtered out by chips and by floor?"). Analysis, not a rule. Every main signal
(fair list + Favorites 24 months) whose 0.15-delta pick fails a floor is walked anyway on that pick (thin_strike.walk_c,
2.10's exits, real quotes, the real price paid): too cheap = under $0.20 ($0.10 IBIT); thin = under 200 contracts in 30
minutes (price over the floor); both = cheap and thin. 2.10's own trades for comparison. Per reason and half: count,
winners, giants (+300% at the 1% basis), median and sum at $10K. A thin pick's price is "fill unproven".

  node --env-file=.env <dir>/run.mjs skip_giants.py      (from the app repo root)
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
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
    src, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    cheap, thin = best[4] < floor, best[5] < 200
    why = "traded (2.10)"
    if cheap and thin: why = "too cheap and thin"
    elif cheap: why = "too cheap"
    elif thin: why = "thin (under 200)"
    x = TS.walk_c(t, m0, best)
    if x is None: return None
    return dict(src=src, date=t["date"], sym=t["sym"], why=why, r1=x["r1"])


def main():
    jobs = [("fair", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25") if t["date"] >= FR.A24]
    print(len(jobs), "main signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    out = {}
    print("\n| List | Half | Reason | Signals | Winners | Giants (+300%) | Median at $10K | Sum at $10K | Sum without giants |")
    print("|---|---|---|---|---|---|---|---|---|")
    for src in ("fair", "fav"):
        for part in ("tune", "check"):
            for why in ("traded (2.10)", "too cheap", "thin (under 200)", "too cheap and thin"):
                rs = [r for r in R if r["src"] == src and half(r["date"]) == part and r["why"] == why]
                if not rs: continue
                usd = [1e4 * max(-1, r["r1"]) for r in rs]
                g = [u for r, u in zip(rs, usd) if r["r1"] >= 3]
                w = sum(u > 0 for u in usd)
                out[f"{src}|{part}|{why}"] = dict(n=len(rs), win=w, giants=len(g), median=round(st.median(usd)), sum=round(sum(usd)))
                print(f"| {src} | {part} | {why} | {len(rs)} | {w} ({w / len(rs):.0%}) | {len(g)} ({len(g) / len(rs):.1%}) | {st.median(usd):+,.0f} | {sum(usd):+,.0f} | {sum(usd) - sum(g):+,.0f} |", flush=True)
    json.dump(out, open("data/local/x/bt/skip_giants_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
