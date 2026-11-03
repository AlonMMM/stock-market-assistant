"""Why do thin (vol30 < 200) S30 trades lose? Compare champion (200+) main trades with the S30 added ones, both halves."""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import spread_nofloor as SN
import fav_real as FR
import floor_exception as fe

def feat(r, v):
    w, p = r["v"][v], r["pick"][v]
    held = w["held"]
    peak = max((x[1] for x in held.values() if x[1] is not None), default=None)
    m30 = held.get(r["minute"] + 30, (None, None))[1]
    return dict(grp="champ" if "champ" in r["v"] else "thin", src=r["src"], sym=r["sym"], minute=r["minute"], d2=r["d2"],
                rvol=r["rvol"], delta=p["delta"], price=p["price"], vol30=p["vol30"], spread=p["spread"],
                r1=max(-1, w["r1"]), over=w["over"], peak=peak, m30=m30)

def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", "main", t) for t in FR.signals("25")]
    with mp.Pool(8) as pool: R = [r for r in pool.map(SN.one, jobs, chunksize=4) if r]
    rows = []
    for r in R:
        if r["src"] == "fav" and r["date"] < FR.A24: continue
        if "champ" in r["v"]: rows.append(feat(r, "champ"))
        elif "S30" in r["v"]: rows.append(feat(r, "S30"))
    json.dump(rows, open("data/local/x/bt/why_thin_rows.json", "w"))
    med = lambda xs: round(st.median(xs), 3) if xs else None
    for src in ("fair", "fav"):
        for g in ("champ", "thin"):
            x = [r for r in rows if r["src"] == src and r["grp"] == g]
            pk = [r["peak"] for r in x if r["peak"] is not None]
            m30 = [r["m30"] for r in x if r["m30"] is not None]
            print(src, g, dict(n=len(x), win=round(sum(r["r1"] > 0 for r in x) / len(x), 3),
                  giants=round(sum(r["r1"] >= 3 for r in x) / len(x), 3), med_r=med([r["r1"] for r in x]),
                  stopped=round(sum(r["r1"] <= -0.35 for r in x) / len(x), 3),
                  peak_med=med(pk), peak_ge50=round(sum(p >= .5 for p in pk) / len(pk), 3), peak_lt10=round(sum(p < .1 for p in pk) / len(pk), 3),
                  m30_med=med(m30), minute_med=med([r["minute"] for r in x]), early60=round(sum(r["minute"] < 60 for r in x) / len(x), 3),
                  late=round(sum(r["minute"] >= 300 for r in x) / len(x), 3), d2=round(sum(r["d2"] for r in x) / len(x), 3),
                  rvol_med=med([r["rvol"] for r in x]), delta_med=med([r["delta"] for r in x]), price_med=med([r["price"] for r in x]),
                  vol30_med=med([r["vol30"] for r in x]), spread_med=med([r["spread"] for r in x if r["spread"] is not None]),
                  over=round(sum(r["over"] for r in x) / len(x), 3), puts=None), flush=True)
    # within champ: does a lower vol30 (200-400) already do worse?
    for src in ("fair", "fav"):
        x = [r for r in rows if r["src"] == src]
        for lo, hi in ((0, 50), (50, 100), (100, 200), (200, 400), (400, 1000), (1000, 10**9)):
            b = [r for r in x if lo <= r["vol30"] < hi]
            if b: print(src, f"vol30 {lo}-{hi}", len(b), "win", round(sum(r["r1"] > 0 for r in b) / len(b), 3), "med", med([r["r1"] for r in b]),
                        "giants", sum(r["r1"] >= 3 for r in b), "peak med", med([r["peak"] for r in b if r["peak"] is not None]), flush=True)

if __name__ == "__main__":
    main()
