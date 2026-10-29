"""The huge winners' paths (the user, 2026-10-28: "is there posability of going up 500% then down to 0 and finish as a big
winner?"). Every champion main trade (retry_roll.py's base: fair list + Favorites 24m, all weeks, real-quote fills),
the option's 1-minute closes while held: the peak over the cost, the lowest point after the peak, the final result.
  node --env-file=.env <dir>/run.mjs peak_paths.py      (from the app repo root) -> data/local/x/bt/peak_paths.json"""
import json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half
from store import day


def one(job):
    src, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    if src == "fav" and date < FR.A24: return None
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    base = rr.leg(sym, date, m0, right, c)
    if not base: return None
    rcost, real, _ = base
    sells = [s for s in real if s[2] == "sell"]
    if not sells: return None
    end = max((s[0], s[1]) for s in sells)
    path = []
    for d in [d for d in rr.CAL if date <= d <= end[0]]:
        for b in day(c[0], d):
            if (d, b[0]) <= (date, m0) or (d, b[0]) > end: continue
            path.append((d, b[0], b[4] * (1 - sim.SH) / rcost - 1))   # the bid, about: the close less the spread
    if not path: return None
    i = max(range(len(path)), key=lambda j: path[j][2])
    low = min(p[2] for p in path[i:])
    return dict(src=src, half=half(date), date=date, sym=sym, right=right, peak=path[i][2], peak_at=f"{path[i][0]} m{path[i][1]}",
                low_after=low, final=sim.result(rcost, real, 0), over=int(end[0] != date), days=len({p[0] for p in path}))


def main():
    jobs = [("fair", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25")]
    with mp.Pool(6) as pool: R = [r for r in pool.map(one, jobs, chunksize=8) if r]
    json.dump(R, open("data/local/x/bt/peak_paths.json", "w"))
    for src in ("fair", "fav"):
        T = [r for r in R if r["src"] == src]
        print(f"\n### {src}: {len(T)} trades")
        for lvl in (3, 5, 10):
            H = [r for r in T if r["peak"] >= lvl]
            if not H: continue
            fin = lambda lo, hi: sum(lo <= r["final"] < hi for r in H)
            print(f"peak >= +{lvl:.0%}: {len(H)} | final: loss {fin(-9, 0)}, 0-100% {fin(0, 1)}, 100-{lvl:.0%} {fin(1, lvl)}, >= +{lvl:.0%} {fin(lvl, 1e9)}"
                  f" | fell to under +100% after the peak: {sum(r['low_after'] < 1 for r in H)}, under 0: {sum(r['low_after'] < 0 for r in H)}")
        print("peak >= +500%, each: date sym side half | peak (when) | lowest after the peak | final | days held")
        for r in sorted((r for r in T if r["peak"] >= 5), key=lambda r: r["date"]):
            print(f"  {r['date']} {r['sym']} {r['right']} {r['half']} | {r['peak']:+.0%} ({r['peak_at']}) | {r['low_after']:+.0%} | {r['final']:+.0%} | {r['days']}")


if __name__ == "__main__":
    main()
