"""A lock that rises with time, on e (the user, 2026-11-07, on GOOGL 2025-05-21: "I really like how you are raising the
line. Can you make it be more high as far as we go? fo example in google I expect exit somwhere around 20:20 ... the
position broke the thessis there and do not go up - we should exit", then "Not really. I do not mind a lock really. I just
want to Lift the curve in function of time"). On e (add_small.py). Set before running, sim.py be_lock `ramp` (new): from
the minute the break-even lock arms (+50% over the average cost), its stock level rises `ramp` x S30 (the stock's
30-minute unit, as the staged exit) an hour our way, never lowered (the break-even update still raises it too); the
entry day, as now:
  R05   0.5 S30 an hour
  R10   1.0 S30 an hour
  R15   1.5 S30 an hour
The user, 2026-11-07: "can you run this test on all? show drop and winners. test cn pass even if it make less money": every
version on tune, check and all weeks; passing (set before the run) = a smaller worst drop and a higher win rate than e on
both lists, on tune and on check, at 2%; money is shown, not a gate. Prior: a stock give-back trail (2.5 / 2.6, 2026-10-27), option trails and locks
(2.10, 2026-11-04/05): none rises with time.

  node --env-file=.env <dir>/run.mjs be_ramp.py      (from the app repo root)
-> data/local/x/bt/be_ramp_summary.json
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import size_volume as SV   # sets 2.9's exits (BT_X); 2.10 = its t3A-c5 sizing
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from score_sum import held as booked
from split import half

B = "data/local/x/bt"
CAL = SV.CAL
S03H = {"spy_turn": {"big": 0.01, "drop": 0.003, "share": 0.5, "stall": 0}}
L04 = {"locks": [[a / 100, b / 100] for a, b in ((100, 25), (200, 75), (300, 100), (500, 200), (1000, 400))]}
# name -> (add share of the first leg, extra exits)
SV.SIZES[0.05] = ("r5", "r25")
PCT = (0.02, 0.03, 0.05)
# name -> (add share, extra exits, the position cut or None)
BE = {"arm": 0.5, "update": True}
VERS = {"e": ("small", S03H, None),
        "R05": ("small", {**S03H, "be_lock": {**BE, "ramp": 0.5}}, None),
        "R10": ("small", {**S03H, "be_lock": {**BE, "ramp": 1.0}}, None),
        "R15": ("small", {**S03H, "be_lock": {**BE, "ramp": 1.5}}, None)}
X2 = {f"{k}-c5" for k in VERS}   # never more than 2x the first leg
IDEAS = {"K": ["R05-c5", "R10-c5", "R15-c5"]}
MODES = ("base-c5",) + tuple(f"{k}-c5" for k in VERS)
for v in MODES: SV.SIZEV[v] = SV.SIZEV["t3A-c5"]


def share_for(k, rvol):
    share, _, _ = VERS[k]
    if share != "small": return share
    small = SV.SIZEV["t3A-c5"](rvol) < 1.0
    return 1.0 if small else 0.25


def over_for(k, kind, rvol, pct=None):
    _, extra, cut = VERS[k]
    share = share_for(k, rvol)
    o = {"stock_stages": {"add": {"within": 10, "move": 1.0, "share": share}}, **extra}
    if cut:
        w = SV.SIZEV["t3A-c5"](rvol) * (0.5 if kind == "add" else 1.0)   # a pyramid add is half its main leg
        o["pos_cap"] = {"units": cut[0] / (pct * w), "share": 0.25, "repeat": cut[1]}
    return o


def vname(x, v, size):
    """A P version's row at this size, else the version's one row."""
    k = f"{v}@{size}"
    return k if k in x else v


def row(t, m, c, rcost, steps):
    _, real = OS.price(steps, c[0], rcost, "bid")
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    held = {}
    for mm in range(m, 390):
        q = RB.quote(c[0], t["date"], mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
    return dict(r1=sim.result(rcost, real, 0.01), r2=sim.result(rcost, real, 0.02), r3=sim.result(rcost, real, 0.03),
                r15=sim.result(rcost, real, 0.015), r05=sim.result(rcost, real, 0.005),
                r5=sim.result(rcost, real, 0.05), r25=sim.result(rcost, real, 0.025),
                over=int(any(s[2] == "carry" for s in steps)), h=booked(rcost, real), held=held,
                exit=next((s[5] for s in reversed(real) if s[2] == "sell"), ""), sells=[s for s in real if s[2] == "sell"],
                added=int(any(s[2] == "buy" and s[5] == "rebuy" for s in real)))


def walk(t, m, c, rcost, over):
    sim.X.clear(); sim.X.update(CHAMP)
    if over: sim.X.update(over)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL, paid=rcost)
    return steps if cost is not None else None


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m = int(t["minute"])
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], float(t["price"]))
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, _ = OS.price(steps, c[0], cost, "bid")
    base = walk(t, m, c, rcost, None)
    if base is None: return None
    rows = {"base-c5": row(t, m, c, rcost, base)}
    rv = float(t.get("c_rvol") or 0)
    for k in VERS:
        names = [(f"{k}-c5", None)]
        if VERS[k][2]: names = [(f"{k}-c5@{p}", p) for p in PCT]
        for name, p in names:
            s_ = walk(t, m, c, rcost, over_for(k, kind, rv, p))
            rows[name] = {**(row(t, m, c, rcost, s_) if s_ else rows["base-c5"]), "share": share_for(k, rv)}
    return dict(src=src, kind=kind, date=t["date"], minute=m, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0),
                v=rows, at={v: m for v in rows}, cuts={v: sum(1 for s in x["sells"] if s[5] in ("BE_lock",)) for v, x in rows.items()})


def entries(R, adds, src, v, part, size, a=""):
    """size_volume.entries, with the 2x line (X2) and part "all" = every week."""
    full, halfk = SV.SIZES[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or r["date"] < a: continue
        if part != "all" and half(r["date"]) != part: continue
        vv = vname(r["v"], v, size)
        if vv not in r["v"]: continue
        x, m = r["v"][vv], r["at"][vv]
        w = SV.SIZEV[v](r.get("rvol", 0))
        E.append((r["date"], m, w, x[full], x["over"], x["h"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            av = vname(ad["v"], v, size)
            if ad["minute"] <= m or av not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            aw = 0.5 * w
            if size < 0.05: aw = min(aw, max(0.0, 0.05 / size - w))   # the position within 5% of the account
            if v in X2 and x.get("added"): aw = min(aw, max(0.0, w * (1 - x.get("share", 0))))
            if share > 0 and up is not None and up > 0 and aw > 1e-9: E.append((ad["date"], ad["minute"], aw, ad["v"][av][halfk], ad["v"][av]["over"], ad["v"][av]["h"]))
            break
    return E


def table(R, adds, part, modes, out, title):
    for size in (0.02, 0.03):
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | **Winners** | Median | Per trade at $10K | End / worst drop | vs 2.10 | vs e | Without the best 5 | Best 5 | Giants · non-giant sum | Lock sales | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in modes:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(entries(R, adds, src, v, part, size, a), size)
                rows = [r for r in R if r["src"] == src and r["kind"] == "main" and r["date"] >= a and (part == "all" or half(r["date"]) == part)]
                s["cut"] = sum(r["cuts"].get(vname(r["v"], v, size), 0) > 0 for r in rows)
                out[f"{part}|{v}|{src}|{size}"] = s
                b = out.get(f"{part}|base-c5|{src}|{size}", s); b2 = out.get(f"{part}|e-c5|{src}|{size}", s)
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | **{s['win']:.1%}** | {s['median']:+,} | {s['per']:+,} | ${s['acct']:,} / {s['dd']:.1%} | {s['acct'] / b['acct']:.3f} | {s['acct'] / b2['acct']:.3f} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {s['cut']} | {yrs} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    if os.environ.get("ST_EVERY"): jobs = jobs[::int(os.environ["ST_EVERY"])]  # a quick smoke run
    print(len(jobs), "signals", flush=True)
    with mp.Pool(10) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", MODES, out, "Tune weeks (even)")
    table(R, adds, "check", MODES, out, "Check weeks (odd), the same run")
    for v in MODES[2:]:
        ok = all(out[f"{p}|{v}|{l}|0.02"]["dd"] < out[f"{p}|e-c5|{l}|0.02"]["dd"] and out[f"{p}|{v}|{l}|0.02"]["win"] > out[f"{p}|e-c5|{l}|0.02"]["win"]
                 for p in ("tune", "check") for l in ("fair", "fav"))
        print(f"\n{'PASS' if ok else 'no'}: {v} (smaller drop and more winners than e on both lists, tune and check, 2%)", flush=True)
    table(R, adds, "all", MODES, out, "All weeks in one account (tune and check joined)")
    json.dump(out, open(f"{B}/be_ramp_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
