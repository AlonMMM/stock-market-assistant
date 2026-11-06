"""Chart data for the check-week main legs the t 1.0 strength exit changed (the user, 2026-11-06: "show me trades from
the checklist it fire on in the graphs"). strength_t1.py's walk, 2.10 vs t10 only; per minute of the entry day: the
stock, SPY, the signal's t vs SPY x beta (as sim.py's thesis exit), volume, the option's mid; both versions' sales.
  node --env-file=.env <dir>/run.mjs t1_charts.py  -> data/local/x/bt/t1_charts.json
"""
import json, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import strength_t1 as S
import fav_real as FR
import floor_exception as fe
import real_bench as RB
import sim
from signals import Day, series
from store import day
from split import half

S.VERS = {"t10": S.VERS["t10"]}


def detail(r, c):
    d, sym, m0 = r["date"], r["sym"], r["minute"]
    bet = 1 if r["right"] == "C" else -1
    sd = Day(sym, d, bet, S.CAL, S.CAL.index(d))
    if not sd.ok: return None
    spy = series(day("SPY", d))[0]
    cs, _, _, vs = series(day(sym, d))
    t = [None] * 390; n = s1 = s2 = 0.0
    for m in range(1, 390):
        if sd.beta is not None and cs[m] and cs[m - 1] and spy[m] and spy[m - 1]:
            x = (cs[m] / cs[m - 1] - 1) - sd.beta * (spy[m] / spy[m - 1] - 1); n += 1; s1 += x; s2 += x * x
        if n >= 5:
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            t[m] = round(mu / math.sqrt(var) * math.sqrt(n), 3) if var > 0 else 0.0
    opt = []
    for m in range(390):
        q = RB.quote(c, d, m) if m >= m0 - 5 else None
        opt.append(None if not q else round((q[0] + q[1]) / 2, 4))
    rd = lambda xs, k=4: [None if x is None else round(x, k) for x in xs]
    return dict(stock=rd(cs), spy=rd(spy, 3), vol=[int(x or 0) for x in vs], t=t, opt=opt, beta=sd.beta)


def one(job):
    r = S.one(job)
    if not r or r["kind"] != "main" or half(r["date"]) != "check": return None
    b, x = r["v"]["base-c5"], r["v"]["t10-c5"]
    if abs(b["r1"] - x["r1"]) < 1e-9: return None
    # the contract: the same pick as S.one
    m = r["minute"]; t = job[2]
    if RB.DBX != S.fm.DBX[job[0]]: RB.DBX = S.fm.DBX[job[0]]; RB.Q.clear(); RB.OI.clear()
    p = fe.choose(S.cu.candidates(t["sym"], t["date"], m, t["right"], float(t["price"])), 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    det = detail(r, p[0][0])
    if not det: return None
    sells = lambda v: [dict(d=s[0], m=s[1], q=s[3], p=s[4], why=s[5]) for s in v["sells"]]
    paid = None
    for mm, (_, g) in sorted(b["held"].items()):
        if g is not None and det["opt"][mm]: paid = round(det["opt"][mm] / (1 + g), 4); break
    return dict(src=r["src"], date=r["date"], sym=r["sym"], right=r["right"], minute=m, contract=p[0][0], paid=paid,
                tEntry=float(t.get("c_t") or 0), rBase=round(b["r1"], 4), rT10=round(x["r1"], 4),
                pnlBase=round(1e4 * max(-1, b["r1"])), pnlT10=round(1e4 * max(-1, x["r1"])),
                over=b["over"], sellsBase=sells(b), sellsT10=sells(x), **det)


if __name__ == "__main__":
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", "main", t) for t in FR.signals("25")]
    jobs = [j for j in jobs if half(j[2]["date"]) == "check" and (j[0] == "fair" or j[2]["date"] >= FR.A24)]
    if os.environ.get("TC_EVERY"): jobs = jobs[::int(os.environ["TC_EVERY"])]
    print(len(jobs), "check signals", flush=True)
    with mp.Pool(10) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    R.sort(key=lambda r: r["pnlT10"] - r["pnlBase"])
    print(len(R), "changed", flush=True)
    json.dump(R, open(f"{S.B}/t1_charts.json", "w"), separators=(",", ":"))
