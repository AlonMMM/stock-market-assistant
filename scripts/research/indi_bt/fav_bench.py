"""The five-version benchmark (export_bench.py) on the user's Favorites, the last 12 and 6 months, plus the next strike for
the D2 entries only (the user, 2026-10-25: "where is next strike only for D2?"; "can you do the same benchmark on my
favorites, last 6 months? then last 12 months?"). Signals: lists.py runs fav86_24 (bot 2.4's entry) and fav86_25 (2.5's),
2025-10-23 to 2026-10-23, the 86 Favorites. The same versions also on the fair list (trade files), for the D2-only rows.
  d25-adjd2        2.5 + the next strike, only for a D2 entry (t < 1.8) whose 0.15-delta strike is illiquid
  d25-cheap-adjd2  the same on top of the cheap fallback
  d25-cheap-nofloor  the cheap fallback and a D2 entry buys under the 200-contract floor (d2_liquid.py cheap+nofloor)
1% / 2% from $100,000 with the 10% overnight cap at each size.

  node --env-file=.env <dir>/run.mjs fav_bench.py      (from the repo root)
"""
import csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import hot_fit_test as hf
import export_bench as eb
import d2_liquid as dl
import news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = eb.CAL
A12, A6, Z = "2025-10-23", "2026-04-23", "2026-10-23"
V = dict(eb.VERSIONS)
LIST = {"s_t18r15": "fav86_24", "sg_c12_15": "fav86_25"}


def contract(t, fb): return eb.contract(t, fb)


def one(job):
    slug, src, t = job
    _, _, exits, fb = V[slug]
    p = contract(t, fb)
    if not p: return None
    sim.X.clear(); sim.X.update(exits)
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], p[0], p[1], CAL)
    if cost is None: return None
    return slug, src, t["date"], t["sym"], sim.result(cost, steps, 0.01), sim.result(cost, steps, 0.02)


def signals():
    out = {}
    for prefix, lname in LIST.items():
        T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
        nf.features(T)
        out[("fair", prefix)] = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
        F = []
        for r in json.load(open(f"{B}/list_{lname}_{A12}_{Z}.json")):
            st = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}.get(r["status"])
            if st: F.append(dict(r, status=st, minute=str(r["minute"])))
        out[("fav", prefix)] = F
    return out


def main():
    S = signals()
    jobs = [(slug, src, t) for slug, v in V.items() for src in ("fair", "fav") for t in S[(src, v[1])] if t["status"] == "ok" or v[3]]
    with mp.Pool(6) as pool: R = [r for r in pool.map(one, jobs, chunksize=8) if r]
    pt = lambda x: 1e4 * max(-1, x)
    for title, src, a in (("Favorites, last 12 months (2025-10-23 to 2026-10-23)", "fav", A12), ("Favorites, last 6 months (2026-04-23 to 2026-10-23)", "fav", A6),
                          ("Fair list, Feb 2024 - Oct 2026", "fair", "2024-01-01")):
        print(f"\n### {title}\n")
        print("| Version | Trades | Winners | Per trade at $10K | At 1% / worst drop | At 2% / worst drop | Without the best 5 at 1% | Best 5 |\n|---|---|---|---|---|---|---|---|")
        for slug, v in V.items():
            T = sorted((r for r in R if r[0] == slug and r[1] == src and r[2] >= a), key=lambda r: r[2])
            if not T: continue
            rows = [dict(date=r[2], pnl=str(pt(r[4]))) for r in T]
            a1, d1 = account(rows); a2, d2 = account([dict(date=r[2], pnl=str(pt(r[5]))) for r in T], 0.02)
            top = sorted(range(len(T)), key=lambda i: -T[i][4])[:5]
            a5, _ = account([x for i, x in enumerate(rows) if i not in set(top)])
            per = sum(float(x["pnl"]) for x in rows) / len(rows)
            best = ", ".join(f"{T[i][3]} {T[i][2][2:]} {pt(T[i][4]) / 1e3:+,.0f}K" for i in top)
            print(f"| {v[0]} | {len(T)} | {sum(r[4] > 0 for r in T)} | {per:+,.0f} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | ${a5:,.0f} | {best} |", flush=True)


def export(out):
    """The Favorites trades for the Bot vs Indi dashboard: versions fav12:<slug> (the last 12 months) and fav6:<slug> (the
    last 6, the same trades from 2026-04-23 with their own account), in export_bench.py's shapes; paths and bars of these
    trades only (the dashboard's paths_fav and the bars appended to the fair list's)."""
    S = signals()
    jobs = [(slug, t) for slug, v in V.items() for t in S[("fav", v[1])] if t["status"] == "ok" or v[3]]
    with mp.Pool(6) as pool: R = [r for r in pool.map(eb.one, jobs, chunksize=8) if r]
    rows, paths = [], []
    for row, path in R:
        for pre, a in (("fav12", A12), ("fav6", A6)):
            if row["date"] < a: continue
            rows.append(dict(row, version=f"{pre}:{row['version']}", key=f"{pre}:{row['key']}"))
            paths.append(dict(path, key=f"{pre}:{path['key']}"))
    keys = set()
    for r in rows:
        i = CAL.index(r["date"])
        for s in (r["sym"], "SPY"): keys.add((s, r["date"], CAL[i - 1]))
    bars = [dict(key=f"{s}|{d}", prev_date=pd, closes=" ".join(eb.closes5(eb.day(s, pd)) + eb.closes5(eb.day(s, d)))) for s, d, pd in sorted(keys)]
    for fname, data in (("fav_trades.csv", rows), ("fav_paths.csv", paths), ("fav_bars.csv", bars)):
        with open(f"{out}/{fname}", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys())); w.writeheader(); w.writerows(data)
        print(fname, len(data), "rows", os.path.getsize(f"{out}/{fname}") // 1024, "KB")


if __name__ == "__main__":
    if sys.argv[1:2] == ["export"]: export(sys.argv[2])
    else: main()
