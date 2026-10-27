"""How sensitive the Main bot (2.6, the live bot) is to its entry bars at one more decimal (the user, 2026-10-26: "what
the change if we use one more number at both signals? for example measuring 1.81 and not 1.8"). Each bar moved by 0.01
up and down, the signals found again (defence_signals.py's scan: a moved bar can make the signal a minute later, not
only drop it), then walked with 2.6: the c12_15 entry (t >= 1.8, or t >= 1.2 and D2 >= 1.5; volume >= 1.5x), the
cheap fallback, no failed-break sale, 2% a trade, the 10% overnight cap. The fair list (HIS40, the news filter).
  node --env-file=.env <dir>/run.mjs indi_precision.py      (from the app repo root)
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import defence_signals as ds
import export_bench as eb
import news_filter as nf
from store import calendar
from low_delta import HIS40, PRIOR
from d2_failed_break import CHAMP

CAL = calendar()
SIZE = 0.02
# name -> (t, D2, which, bonus t, volume)
BASE = (1.8, 1.5, "e", 1.2, 1.5)
RULES = {"base: t 1.8, D2 1.5, bonus t 1.2, vol 1.5": BASE}
for i, label in ((0, "t"), (1, "D2"), (3, "bonus t"), (4, "vol")):
    for dx in (0.01, -0.01):
        r = list(BASE); r[i] = round(r[i] + dx, 2)
        RULES[f"{label} {r[i]}"] = tuple(r)
RULES["all +0.01"] = (1.81, 1.51, "e", 1.21, 1.51)
RULES["all -0.01"] = (1.79, 1.49, "e", 1.19, 1.49)


def passes(rule, t, rv, d, e):
    tt, dx, which, bonus, rvmin = rule
    if rv < rvmin: return False
    dv = d if which == "d" else e
    return t >= tt or (t >= bonus and dv >= dx)


ds.passes = passes
ds.RULES = RULES


def walk(t):
    picked, why = sim.pick(t["sym"], t["date"], t["minute"], t["right"], float(t["price"]))
    if picked: t = dict(t, status="ok", contract=picked[0], expiry=picked[1])
    else: t = dict(t, status=why)
    p = eb.contract(dict(t, minute=str(t["minute"])), "cheap") if t["status"] in ("ok", "too_cheap") else None
    if not p: return None
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], t["minute"], t["right"], p[0], p[1], CAL)
    return None if cost is None else sim.result(cost, steps, SIZE)


def account(R):
    eq, top, dd, by = 1e5, 1e5, 0.0, {}
    for d, ret in R: by.setdefault(d, []).append(ret)
    for d in sorted(by):
        eq *= 1 + sum(r * SIZE for r in by[d]); top = max(top, eq); dd = max(dd, 1 - eq / top)
    return eq, dd


def main():
    syms = sorted(HIS40)
    with mp.Pool(8) as pool: parts = pool.map(ds.stock, syms)
    sig = {name: [r for p in parts for r in p[name]] for name in RULES}
    allrows = [r for rows in sig.values() for r in rows]
    nf.features(allrows)
    for name in RULES:
        sig[name] = [t for t in sig[name] if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in PRIOR[t["date"][:4]]]
    key = lambda t: (t["date"], t["sym"], t["minute"], t["right"])
    uniq = {key(t): t for rows in sig.values() for t in rows}
    with mp.Pool(8) as pool: res = dict(zip(uniq, pool.map(walk, list(uniq.values()), chunksize=8)))
    base = {(t["date"], t["sym"]): key(t) for t in sig[list(RULES)[0]]}
    for title, a, z in (("Fair list 2024-2025", "2024-01-01", "2025-12-31"), ("Fair list 2026 (to Oct 12)", "2026-01-01", "2026-12-31")):
        print(f"\n### {title}, 2.6 at 2%\n\n| Bars | Signals | New | Gone | Later / earlier minute | Traded | End ($100K) | Worst drop |\n|---|---|---|---|---|---|---|---|")
        b0 = {k: v for k, v in base.items() if a <= k[0] <= z}
        for name in RULES:
            rows = [t for t in sig[name] if a <= t["date"] <= z]
            mine = {(t["date"], t["sym"]): key(t) for t in rows}
            new = sum(1 for k in mine if k not in b0); gone = sum(1 for k in b0 if k not in mine)
            moved = sum(1 for k in mine if k in b0 and mine[k] != b0[k])
            R = [(t["date"], res[key(t)]) for t in rows if res.get(key(t)) is not None]
            eq, dd = account(R)
            print(f"| {name} | {len(rows)} | {new} | {gone} | {moved} | {len(R)} | ${eq:,.0f} | {100 * dd:.1f}% |", flush=True)


if __name__ == "__main__": main()
