"""Where the thin skips are (the user, 2026-10-30, after ten_back.py: "1,983 signals before 10:00 were skipped for too few
contracts - can you show me desribution?"). Every champion main signal (fair list + Favorites): its minute, whether the pick
is thin (price over the floor, under 200 contracts in 30 minutes), the pick's 30-minute volume -> data/local/x/bt/thin_dist.csv.

  node --env-file=.env <dir>/run.mjs thin_dist.py
"""
import csv, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import cheap_up as cu
import fav_real as FR
import floor_exception as fe
from split import half


def one(job):
    src, t = job
    sym, date, right, m, px = t["sym"], t["date"], t["right"], int(t["minute"]), float(t["price"])
    cands = cu.candidates(sym, date, m, right, px)
    if not cands: return (src, sym, date, right, m, "none", "", "", half(date))
    b = min(cands, key=lambda c: abs(c[3] - 0.15))
    floor = 0.10 if sym == "IBIT" else 0.20
    if b[4] < floor: state = "cheap"
    elif b[5] < 200: state = "thin"
    else: state = "ok"
    return (src, sym, date, right, m, state, b[5], round(b[4], 2), half(date))


def main():
    jobs = [("fair", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25")]
    with mp.Pool(8) as pool: rows = pool.map(one, jobs, chunksize=8)
    with open("data/local/x/bt/thin_dist.csv", "w") as f:
        w = csv.writer(f); w.writerow(["src", "sym", "date", "right", "minute", "state", "vol30", "price", "half"]); w.writerows(rows)
    print(len(rows), "signals -> data/local/x/bt/thin_dist.csv")


if __name__ == "__main__":
    main()
