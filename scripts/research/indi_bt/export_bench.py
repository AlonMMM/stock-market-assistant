"""The benchmark for the Bot vs Indi dashboard (the user, 2026-10-25: "there is a mess - show me the benchmark on our
regular report (reduce the number of options there)"): five bot versions only, every one walked again here on the fair
list with the 10% overnight cap, in the dashboard's trades / paths / bars file shapes (export_defence.py's).
  bot24        the live bot 2.4 (t >= 1.8, the rest-stop exits, the failed-break sale)
  d2-bonus     version 2.5 (PR #147): the D2 bonus entry, no failed break
  d25-cheap    2.5 + the cheap fallback (under $0.20: the nearest-the-money strike at $0.20 or more; cheap_up.py)
  d24-adj      2.4 + the next strike on each side when the 0.15-delta one is illiquid (hot_fit_test.py adj)
  d25-nofloor  2.5 + a D2 entry buys under the 200-contract floor (d2_liquid.py nofloor; the fill is unproven)
  d25-adjd2    2.5 + the next strike, only for a D2 entry (t < 1.8) whose 0.15-delta strike is illiquid
  d25-cheap-adjd2 / d25-cheap-nofloor   the same two on top of the cheap fallback

  node --env-file=.env <dir>/run.mjs export_bench.py <out dir>      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import cheap_up2 as cu2
import hot_fit_test as hf
import d2_liquid as dl
import news_filter as nf
from store import calendar, day
from low_delta import HIS40, PRIOR
from export_defence import words, closes5
from d2_failed_break import CHAMP

B = "data/local/x/bt"
CAL = calendar()
# slug -> (name, trade files, exits, fallback)
VERSIONS = {
    "bot24": ("Live bot (2.4)", "s_t18r15", cu2.BOT24, None),
    "d2-bonus": ("Version 2.5: + the D2 bonus entry (PR #147)", "sg_c12_15", CHAMP, None),
    "d25-cheap": ("2.5 + the cheap fallback", "sg_c12_15", CHAMP, "cheap"),
    "d24-adj": ("2.4 + the next strike when illiquid", "s_t18r15", cu2.BOT24, "adj"),
    "d25-nofloor": ("2.5 + D2 entries buy under 200 contracts (fill unproven)", "sg_c12_15", CHAMP, "nofloor"),
    # the user, 2026-10-25: "where is next strike only for D2?"; "combination with d2 entries and fill under 200 + cheap fallback"
    "d25-adjd2": ("2.5 + the next strike, D2 entries only", "sg_c12_15", CHAMP, "adjd2"),
    "d25-cheap-adjd2": ("2.5 + cheap + the next strike for D2 entries", "sg_c12_15", CHAMP, "cheap+adjd2"),
    "d25-cheap-nofloor": ("2.5 + cheap + D2 entries buy under 200 contracts (fill unproven)", "sg_c12_15", CHAMP, "cheap+nofloor"),
}
SIZES = (0.01, 0.02, 0.03, 0.04, 0.05)


def contract(t, fb):
    if t["status"] == "ok": return t["contract"], t["expiry"]
    m, spot = int(t["minute"]), float(t["price"])
    c = None
    if fb == "cheap" and t["status"] == "too_cheap": c, _ = cu.choose(cu.candidates(t["sym"], t["date"], m, t["right"], spot), "cheap")
    if fb == "adj" and t["status"] == "illiquid": c, _ = hf.choose(cu.candidates(t["sym"], t["date"], m, t["right"], spot), "adj", t["sym"], t["right"])
    if fb == "nofloor" and t["status"] == "illiquid" and float(t["c_t"]) < 1.8: c, _ = dl.pick_at(t, m, spot, False, floor=False)
    if fb == "cheap+nofloor": c, _ = dl.pick_at(t, m, spot, True, floor=float(t["c_t"]) >= 1.8)
    if fb in ("adjd2", "cheap+adjd2"):
        cheap = fb.startswith("cheap")
        cands = cu.candidates(t["sym"], t["date"], m, t["right"], spot)
        c, why = cu.choose(cands, "cheap" if cheap else "plain")
        if not c and why == "illiquid" and float(t["c_t"]) < 1.8: c = hf.choose(cands, "cheap_adj" if cheap else "adj", t["sym"], t["right"])[0]
    return (c[0], c[1]) if c else None


def one(job):
    slug, t = job
    name, _, exits, fb = VERSIONS[slug]
    p = contract(t, fb)
    if not p: return None
    sim.X.clear(); sim.X.update(exits)
    m0 = int(t["minute"])
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], p[0], p[1], CAL)
    if cost is None: return None
    key = f"{slug}-{t['date']}-{t['sym']}-{t['right']}-{m0}"
    last = [s for s in steps if s[2] == "sell"][-1]
    row = dict(version=slug, version_name=name, key=key, date=t["date"], time=t["time"], minute=m0, sym=t["sym"], right=t["right"],
               contract=p[0], iv=t.get("iv", ""), ret=round(sim.result(cost, steps, 0.01), 4), exit=words(steps), overnight=int(last[0] != t["date"]),
               **{f"ret_{round(s * 100)}pct": round(sim.result(cost, steps, s), 4) for s in SIZES[1:]}, ret_nocap=round(sim.result(cost, steps, 0), 4),
               added=int(t["status"] != "ok"))
    days = [d for d in CAL if t["date"] <= d <= last[0]]
    opt = "|".join(f"{d}: " + " ".join(closes5([b for b in day(p[0], d) if d != t["date"] or b[0] >= m0])) for d in days)
    after = "|".join(f"{d}: " + " ".join(closes5(day(t["sym"], d))) for d in days[1:])
    path = dict(key=key, cost=round(cost, 4), steps=";".join(f"{s[0]},{s[1]},{s[2]},{s[3]},{s[4]},{s[5]}" for s in steps), option=opt, stock_after=after)
    return row, path


def main():
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    sig = {}
    for prefix in ("s_t18r15", "sg_c12_15"):
        T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
        nf.features(T)
        sig[prefix] = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]),
                             key=lambda t: (t["date"], int(t["minute"])))
    jobs = [(slug, t) for slug, v in VERSIONS.items() for t in sig[v[1]] if t["status"] == "ok" or v[3]]
    with mp.Pool(6) as pool: R = [r for r in pool.map(one, jobs, chunksize=8) if r]
    rows, paths = [r[0] for r in R], [r[1] for r in R]
    keys = set()
    for r in rows:
        i = CAL.index(r["date"])
        for s in (r["sym"], "SPY"): keys.add((s, r["date"], CAL[i - 1]))
    bars = [dict(key=f"{s}|{d}", prev_date=pd, closes=" ".join(closes5(day(s, pd)) + closes5(day(s, d)))) for s, d, pd in sorted(keys)]
    for fname, data in (("bench_trades.csv", rows), ("bench_paths.csv", paths), ("bench_bars.csv", bars)):
        with open(f"{out}/{fname}", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys())); w.writeheader(); w.writerows(data)
        print(fname, len(data), "rows", os.path.getsize(f"{out}/{fname}") // 1024, "KB")
    for slug in VERSIONS: print(slug, sum(r["version"] == slug for r in rows), "trades")


if __name__ == "__main__":
    main()
