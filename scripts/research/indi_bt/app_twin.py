"""app_twin.py: the research twin of the app's Backtest page for the Main bot 2.7.0, on any list and period (the user,
2026-11-01: "run the app backtest and the local backtest ... I expect it to be the same trade exactly"): export_champ.py's "champ" (2.5's entry = t >= 1.8
or the D2 bonus, the news filter, delta 0.15, IBIT down to $0.10, no cheap fallback, the pyramid half-size add on 2.4's
entry, CHAMP exits), minute-close entries, the walk's default fixes (BT_CLOCK=stock, BT_CHASE=ask, BT_BASIS n/a).
Prices: the f2 walk (option bars +-2%, what the walk decides on) and the real book re-price (OS.price, "real").

  node --env-file=.env scripts/research/indi_bt/run.mjs app_twin.py <first> <last> <SYM,SYM,...> <out.json>   (from the app repo root)
-> out.json: every trade (contract, the walk's steps, the real fills) and every skip. The app side and the trade-by-trade
compare (both through the app's own account) are scripts/bot-backtest-compare.ts in the app repo.
"""
import datetime as dt, json, multiprocessing as mp, os, sys
IB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, IB)
os.environ.setdefault("BT_VARIANT", "v2")
from store import P, fetch_bars, calendar
from fetch_context import pre
import earnings

A, Z, SYMS, OUT = sys.argv[1], sys.argv[2], sys.argv[3].split(","), sys.argv[4]


def prep():
    start = (dt.date.fromisoformat(A) - dt.timedelta(days=45)).isoformat()
    allsyms = ["SPY"] + SYMS
    for i in range(0, len(allsyms), 50):
        part = allsyms[i:i + 50]
        fetch_bars("stocks", part, start, Z, key=f"list|{','.join(part)}|{start}|{Z}")
        pre(part, start, Z)
    P["universe_fav"] = sorted(set(P.get("universe_fav", [])) | set(SYMS))
    earnings.main("2022-12-01", Z)


import sim, tune_signals as ts, news_filter as nf, defence_signals as ds
import cheap_up as cu, floor_exception as fe, opt_spread as OS, real_bench as RB, fill_models as fm
from d2_failed_break import CHAMP
CAL = calendar()

def init():
    RB.DBX = fm.DBX["fav"]; RB.Q.clear(); RB.OI.clear()


def walk(t, c):
    sim.X.clear(); sim.X.update(CHAMP); sim.SH = 0.02
    m0 = int(t["minute"])
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    if os.environ.get("TWIN_BASIS", "real") == "real" and rcost != cost:
        # BT_BASIS=real (export_early.rewalk): walk again with the real fill as the cost, so the exits read the paid price
        sim.X.clear(); sim.X.update(CHAMP)
        c2, s2, _ = sim.walk(t["sym"], t["date"], m0, t["right"], c[0], c[1], CAL, paid=rcost)
        if c2 is not None:
            cost, steps = c2, s2
            _, real = OS.price(steps, c[0], rcost, "bid")
            real = [steps[0][:4] + (rcost, steps[0][5])] + real[1:]
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    held = {}
    for mm in range(m0, 390):
        k = RB.quote(c[0], t["date"], mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return dict(cost=cost, steps=steps, rcost=rcost, real=real, held=held,
                ret=sim.result(cost, steps, 0.03), ret_real=sim.result(rcost, real, 0.03))


def one(job):
    kind, t = job
    sim.pick(t["sym"], t["date"], int(t["minute"]), t["right"], float(t["price"]))   # fetches the option bars it lacks
    cands = cu.candidates(t["sym"], t["date"], int(t["minute"]), t["right"], float(t["price"]))
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    p = fe.choose(cands, floor, "none")
    if not p:
        best = min(cands, key=lambda c: abs(c[3] - 0.15)) if cands else None
        why = "no_prices" if not best else ("too_cheap" if best[4] < floor else "illiquid")
        return kind, t, None, why
    c = p[0]
    w = walk(t, c)
    return kind, t, (c, w), None if w else "no_fill"


def news_ok(t): return t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)


def main():
    prep()
    ts.SPAN = {"w": (A, Z)}; ts.RULES = {"t18r15": (1.8, 1.5, None)}
    ds.SPAN = {"w": (A, Z)}; ds.RULES = {"c12_15": ds.RULES["c12_15"]}
    mains = [r for s in SYMS for r in ds.stock(s)["c12_15"]]
    adds = [r for s in SYMS for r in ts.stock(s)["t18r15"]]
    nf.CAL[:] = CAL; nf.IDX.clear(); nf.IDX.update({d: i for i, d in enumerate(CAL)})
    nf.features(mains); nf.features(adds)
    skipped = [dict(sym=t["sym"], date=t["date"], minute=int(t["minute"]), right=t["right"],
                    reason="earnings" if t["e_next"] == 0 else "premarket") for t in mains if not news_ok(t)]
    jobs = [("main", t) for t in mains if news_ok(t)] + [("add", t) for t in adds if news_ok(t)]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8, initializer=init) as pool: R = pool.map(one, jobs, chunksize=2)
    addby = {}
    for kind, t, res, why in R:
        if kind == "add": addby.setdefault((t["date"], t["sym"], t["right"]), []).append((t, res))
    out = []
    def row(t, c, w, half):
        return dict(sym=t["sym"], date=t["date"], minute=int(t["minute"]), right=t["right"], t=float(t.get("c_t") or 0),
                    contract=c[0], expiry=c[1], strike=c[2], delta=round(c[3], 3), pick_price=c[4], vol30=c[5], add=half,
                    cost=round(w["cost"], 4), rcost=round(w["rcost"], 4),
                    steps=[list(s) for s in w["steps"]], real=[list(s) for s in w["real"]],
                    ret3=round(w["ret"], 4), ret3_real=round(w["ret_real"], 4))
    for kind, t, res, why in R:
        if kind != "main": continue
        if not res or not res[1]:
            skipped.append(dict(sym=t["sym"], date=t["date"], minute=int(t["minute"]), right=t["right"], reason=why)); continue
        c, w = res
        out.append(row(t, c, w, False))
        if float(t.get("c_t") or 9) < 1.8:
            for a, ares in sorted(addby.get((t["date"], t["sym"], t["right"]), []), key=lambda x: int(x[0]["minute"])):
                if int(a["minute"]) <= int(t["minute"]) or not ares or not ares[1]: continue
                share, up = w["held"].get(int(a["minute"]), (0, None))
                if share > 0 and up is not None and up > 0: out.append(row(a, ares[0], ares[1], True))
                break
    json.dump(dict(from_=A, to=Z, syms=SYMS, trades=out, skips=skipped), open(OUT, "w"), default=str, indent=1)
    print(len(out), "trades", len(skipped), "skips", flush=True)


if __name__ == "__main__":
    main()
