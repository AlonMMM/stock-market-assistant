"""The 1DTE giants of the check weeks (fair list, main legs, 2.10 >= +300%) with 2.10's and the user's ladder's sales,
and their stock / option paths for charts (the user, 2026-11-05: "show me these 7 gaintes on graphs")."""
import json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import dte1_ladder as DL
import floor_exception as fe, fill_models as fm, opt_spread as OS, real_bench as RB, sim, cheap_up as cu
from store import day
from split import half

def job(t):
    if RB.DBX != fm.DBX["fair"]: RB.DBX = fm.DBX["fair"]; RB.Q.clear(); RB.OI.clear()
    m = int(t["minute"])
    p = fe.choose(cu.candidates(t["sym"], t["date"], m, t["right"], float(t["price"])), 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    if c[1] not in DL.IDX or DL.IDX[c[1]] - DL.IDX[t["date"]] != 1: return None
    sim.X.clear(); sim.X.update(DL.CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], DL.CAL)
    if cost is None: return None
    rcost, _ = OS.price(steps, c[0], cost, "bid")
    out = {}
    for name, over in (("2.10", None), ("U", DL.VERS["U"])):
        s_ = DL.walk(t, m, c, rcost, over)
        _, real = OS.price(s_, c[0], rcost, "bid")
        out[name] = dict(r1=sim.result(rcost, real, 0.01), sells=[[x[0], x[1], x[3], x[4], x[5]] for x in real if x[2] == "sell"])
    if out["2.10"]["r1"] < 3: return None
    days = [d for d in DL.CAL if t["date"] <= d <= c[1]]
    path = []
    for d in days:
        bars = {b[0]: b[4] for b in day(t["sym"], d)}
        for mm in range(m if d == t["date"] else 0, 390):
            q = RB.quote(c[0], d, mm)
            path.append([d, mm, bars.get(mm), round((q[0] + q[1]) / 2, 3) if q and q[1] > 0 else None])
    return dict(sym=t["sym"], date=t["date"], minute=m, right=t["right"], contract=c[0], expiry=c[1], paid=round(rcost, 3),
                stock0=float(t["price"]), v=out, path=path)

if __name__ == "__main__":
    T = [t for t in fe.fair_signals("sg_c12_15") if half(t["date"]) == "check"]
    with mp.Pool(10) as pool: R = [r for r in pool.map(job, T, chunksize=4) if r]
    R.sort(key=lambda r: -r["v"]["2.10"]["r1"])
    for r in R: print(r["sym"], r["date"], r["right"], r["contract"], f'2.10 {r["v"]["2.10"]["r1"]:+.0%}  U {r["v"]["U"]["r1"]:+.0%}', r["v"]["2.10"]["sells"], "|", r["v"]["U"]["sells"])
    json.dump(R, open(os.path.join(os.environ.get("OUT", "."), "giants_1dte.json"), "w"))
