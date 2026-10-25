"""Ways to cut the worst drop of 2.5 + cheap + the next strike for D2 (the user, 2026-10-25: "try and find a way to reduce
somehow the drop in the cheap + liquid. I do not care to lose some money but I need this data").

Every way is judged against the yardstick of a smaller flat size (it also cuts the drop): a way is worth having only
when, at its worst drop, it ends above the flat size with the same drop ("edge over flat"). Set before running:
  flat 0.5-1.0%           the yardstick
  sizing (sizing_sweep)   cut the size below a drawdown, after a losing streak, a month stop, a day stop (the day stop
                          counts a trade's result when it is bought, so it looks ahead within the day: an upper bound)
  per day                 at most 1 / 2 / 3 new trades a day (the first by minute)
  by entry                the D2 bonus entries (t < 1.8) at half size; the fallback-added trades at half size; both
  night                   the overnight cap at 5% and 7.5% of the account instead of 10%; holding from +100% not +50%
  exits                   the -30% stop at -25% and -20%; the 10-minute check sells all, not half
Fair list, Feb 2024 - Oct 2026, from $100,000 at 1% (the 10% night cap unless the row says otherwise).

  node --env-file=.env <dir>/run.mjs dd_reduce.py      (from the repo root)
"""
import csv, glob, itertools, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import news_filter as nf
import sizing_sweep as sw
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
CAL = eb.CAL
BASE = "d25-cheap-adjd2"
_n, _p, _x, _f = eb.VERSIONS[BASE]
US = _x["user_stop"]
EXITS = {
    "stop -25%": {**_x, "user_stop": {**US, "out": -0.25}},
    "stop -20%": {**_x, "user_stop": {**US, "out": -0.20}},
    "10-min check sells all": {**_x, "user_stop": {**US, "checks": [[10, 1.0], [20, 1.0]]}},
    "hold overnight from +100%": {**_x, "carry_min_gain": 1.0},
}
for _k, _v in EXITS.items(): eb.VERSIONS[f"{BASE}|{_k}"] = (_n, _p, _v, _f)  # at import, for the pool's workers


def walk(job):
    slug, t = job
    r = eb.one((slug, t))
    if not r: return None
    row, path = r
    steps = [s.split(",") for s in path["steps"].split(";")]
    steps = [(a, int(b), c, float(d), float(e), f) for a, b, c, d, e, f in steps]
    cost = float(path["cost"])
    caps = {}
    for cap in (0.05, 0.075):
        sim.NIGHT_CAP = cap; caps[cap] = sim.result(cost, steps, 0.01)
    sim.NIGHT_CAP = 0.1
    return slug, dict(row, c_t=t["c_t"], cap5=caps[0.05], cap75=caps[0.075])


def account(T, size=lambda t: 1.0, per_day=None, field="ret", streak=None):
    """1% x size(t) of the account at the start of each day; at most `per_day` new trades a day (first by minute);
    streak (k, factor): after k losing trades in a row (in entry order, so within a day it knows results early, as
    sizing_sweep), x factor until a winner."""
    eq, peak, dd, cur, start, n, taken, run_ = 1e5, 1e5, 0.0, None, 1e5, 0, [], 0
    for t in T:
        if t["date"] != cur: cur, start, n = t["date"], eq, 0; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        if per_day and n >= per_day: continue
        n += 1; taken.append(t)
        f = streak[1] if streak and run_ >= streak[0] else 1.0
        r = max(-1, float(t[field]))
        eq += 0.01 * size(t) * f * start * r
        run_ = run_ + 1 if r <= 0 else 0
    return eq, max(dd, 1 - eq / max(peak, eq)), taken


def wo5(T, **k):
    top = set(id(t) for t in sorted(T, key=lambda t: -float(t[k.get("field", "ret")]))[:5])
    return account([t for t in T if id(t) not in top], **k)[0]


def main():
    sig = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(sig)
    sig = [t for t in sig if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
    jobs = [(BASE, t) for t in sig] + [(f"{BASE}|{k}", t) for k in EXITS for t in sig]
    with mp.Pool(6) as pool: R = [r for r in pool.map(walk, jobs, chunksize=8) if r]
    by = {}
    for slug, row in R: by.setdefault(slug, []).append(row)
    for v in by.values(): v.sort(key=lambda r: (r["date"], int(r["minute"])))
    T = by[BASE]
    flat = []
    rows = []
    for s in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0):
        e, d, _ = account(T, size=lambda t, s=s: s)
        flat.append((d, e)); rows.append(("yardstick", f"flat {s:g}%", len(T), e, d, wo5(T, size=lambda t, s=s: s)))
    add = lambda fam, name, T_, **k: rows.append((fam, name, len(account(T_, **k)[2]), *account(T_, **k)[:2], wo5(T_, **k)))
    for n in (1, 2, 3): add("per day", f"at most {n} new trade{'s' if n > 1 else ''} a day", T, per_day=n)
    d2 = lambda t: float(t["c_t"]) < 1.8
    add("by entry", "D2 bonus entries (t < 1.8) at half size", T, size=lambda t: 0.5 if d2(t) else 1.0)
    add("by entry", "fallback-added trades at half size", T, size=lambda t: 0.5 if t["added"] == 1 else 1.0)
    add("by entry", "both at half size", T, size=lambda t: 0.5 if d2(t) or t["added"] == 1 else 1.0)
    add("night", "overnight cap 7.5%", T, field="cap75")
    add("night", "overnight cap 5%", T, field="cap5")
    for k in EXITS: add("exits" if "night" not in k and "overnight" not in k else "night", k, by[f"{BASE}|{k}"])
    half_added = lambda t: 0.5 if t["added"] == 1 else 1.0
    for k, fac in itertools.product((3, 5, 8), (0.5, 0.25)):
        add("streak", f"x{fac:g} after {k} losers", T, streak=(k, fac))
        add("combined", f"fallback-added at half + x{fac:g} after {k} losers", T, size=half_added, streak=(k, fac))
    add("combined", "fallback-added at half + 10-min check sells all", by[f"{BASE}|10-min check sells all"], size=half_added)
    add("combined", "fallback-added at half + cap 7.5%", T, size=half_added, field="cap75")
    for rule, p, s in sw.grid():
        if s != 1 or rule not in ("dd_cut", "day_stop", "month_cap"): continue
        e, d, taken = sw.run(T, CAL, s, rule, **p)
        rows.append(("sizing", sw.label(rule, p, s), taken, e, d, None))
    print(f"\n### {BASE} on the fair list: {len(T)} trades; base ${account(T)[0]:,.0f} / {account(T)[1]:.0%}\n")
    print("| Family | Way | Trades | Account at 1% | Worst drop | Flat size with the same drop | Edge over flat | Without the best 5 |\n|---|---|---|---|---|---|---|---|")
    keep = [r for r in rows if r[0] != "sizing"]
    sizing = sorted([r for r in rows if r[0] == "sizing"], key=lambda r: -(r[3] / (sw.edge(flat, r[4], r[3]) or r[3])))
    for fam, name, n, e, d, w in keep + sizing[:6]:
        f = sw.edge(flat, d, e)
        fe = f"${f:,.0f}" if f else "beyond flat 0.5-1%"
        ed = f"{e / f - 1:+.0%}" if f else ""
        print(f"| {fam} | {name} | {n} | ${e:,.0f} | {d:.0%} | {fe} | {ed} | {'' if w is None else f'${w:,.0f}'} |", flush=True)


if __name__ == "__main__":
    main()
