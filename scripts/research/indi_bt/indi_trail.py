"""The Volume bot's exit as a stop for the Main bot (the user, 2026-10-26: "test this strategy as stop ... 2 parts like
10-20 minutes check ... permutations ... only indi fair for 2024-2025"). sim.py stock_trail: on the entry day, out
once the stock gives back k x S30 from its best since the entry; the first early_min minutes use early_k (none: no
such stop yet). On top of each version's own exits: 2.6 (the live bot, 2026-10-26: the D2 bonus entry, no failed-break
sale, the cheap fallback) and 2.5 (the same without the cheap fallback). The fair list (export_bench.py's signals),
2024-2025, 2% a trade (the live size) with the 10% overnight cap.
  node --env-file=.env <dir>/run.mjs indi_trail.py      (from the app repo root)
BT_TRAIL_FAV=1: the user's 86 Favorites instead, 2026 (lists.py's fav86_24 / fav86_25 signals), the leading stops only
("can you test the candidate on my favorite 2026?").
"""
import json
import csv, glob, itertools, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import news_filter as nf
from store import calendar
from low_delta import HIS40, PRIOR
from d2_failed_break import CHAMP

B = "data/local/x/bt"
CAL = calendar()
BOTS = {"2.6 (live)": ("sg_c12_15", CHAMP, "cheap"), "2.5": ("sg_c12_15", CHAMP, None)}
SIZE = 0.02
K2 = (0.5, 0.75, 1.0, 1.5, 2.0)
TRAILS = {"none": None}
for k in K2: TRAILS[f"{k}"] = dict(k=k)
for em, ek, k in itertools.product((10, 20), (None, 1.0, 1.5, 2.0), K2):
    if ek is not None and ek <= k: continue   # the first part looser than the rest, or no stop at all
    TRAILS[f"{em}m:{'off' if ek is None else ek}>{k}"] = dict(k=k, early_min=em, early_k=ek)
for name in [n for n in TRAILS if n != "none"]: TRAILS[f"{name} losing only"] = dict(TRAILS[name], only_losing=True)


FAV = bool(os.environ.get("BT_TRAIL_FAV"))
if FAV: TRAILS = {n: TRAILS[n] for n in ("none", "2.0 losing only", "20m:off>1.0 losing only", "20m:2.0>1.0 losing only", "20m:1.5>1.0 losing only")}


def signals(prefix):
    if FAV:
        lname = {"s_t18r15": "fav86_24", "sg_c12_15": "fav86_25"}[prefix]
        R = json.load(open(f"{B}/list_{lname}_2025-10-23_2026-10-23.json"))
        st = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}
        return [dict(r, status=st[r["status"]], minute=str(r["minute"])) for r in R if r["status"] in st and r["date"] >= "2026-01-01"]
    T = [t for f in glob.glob(f"{B}/{prefix}_202[45].[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    return [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]


def one(job):
    bot, name, t = job
    _, exits, fb = BOTS[bot]
    p = eb.contract(t, fb)
    if not p: return None
    sim.X.clear(); sim.X.update(exits)
    if TRAILS[name]: sim.X["stock_trail"] = TRAILS[name]
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], p[0], p[1], CAL)
    if cost is None: return None
    return bot, name, t["date"], int(t["minute"]), sim.result(cost, steps, SIZE), any(s[5] == "S_trail" for s in steps)


def account(R):
    eq, top, dd, by = 1e5, 1e5, 0.0, {}
    for d, m, ret in sorted(R): by.setdefault(d, []).append(ret)
    for d in sorted(by):
        eq *= 1 + sum(r * SIZE for r in by[d]); top = max(top, eq); dd = max(dd, 1 - eq / top)
    return eq, dd


def main():
    jobs = []
    for bot, (prefix, _, _) in BOTS.items():
        T = signals(prefix)
        jobs += [(bot, name, t) for name in TRAILS for t in T if t["status"] == "ok" or BOTS[bot][2]]
    with mp.Pool(8) as pool: res = [r for r in pool.map(one, jobs, chunksize=16) if r]
    for bot in BOTS:
        print(f"\n### {bot}, {'Favorites 2026' if FAV else 'fair list 2024-2025'}\n\n| Stop | Trades | Win | Avg return | Trail fired | End ($100K) | Worst drop |\n|---|---|---|---|---|---|---|")
        rows = []
        for name in TRAILS:
            R = [r for r in res if r[0] == bot and r[1] == name]
            eq, dd = account([(r[2], r[3], r[4]) for r in R])
            rows.append((eq, f"| {name} | {len(R)} | {100 * sum(r[4] > 0 for r in R) / len(R):.0f}% | {100 * sum(r[4] for r in R) / len(R):+.1f}% | {sum(r[5] for r in R)} | ${eq:,.0f} | {100 * dd:.1f}% |"))
        base = rows[0]
        print(base[1])
        for eq, line in sorted(rows[1:], key=lambda x: -x[0]): print(line)


if __name__ == "__main__": main()
