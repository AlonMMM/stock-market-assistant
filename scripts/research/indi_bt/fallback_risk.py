"""The contract fallbacks under the trading service's risk manager (the user, 2026-10-25: "can you combine our risk
management with it?"). The live bot 2.4's trades with each pick (cheap_up2.py: plain, cheap, liquid2, both2) are run
through risk_overlay.py's account: no risk manager, today's (refused when over), PR #130 (half size under the brake)
and sized to fit; 1% and 2% a trade from $100,000. Fair list and 151 unseen.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs fallback_risk.py      (from the repo root)
"""
import csv, datetime as dt, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import cheap_up2 as c2
import news_filter as nf
import risk_overlay as ro
from store import calendar
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
CAL = calendar()
MODES = ("plain", "cheap", "liquid2", "both2")
RISK = (("none", "no risk manager"), ("refuse", "today: refused when over"), ("half", "PR #130: half under the brake"), ("reactive", "sized to fit"))


def one(t):
    minute, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], minute, t["right"], spot) if t["status"] in ("too_cheap", "illiquid") else []
    out = {}
    for mode in MODES:
        if t["status"] == "ok": sym_, exp = t["contract"], t["expiry"]
        elif mode == "plain": continue
        else:
            c, _ = c2.choose(cands, mode)
            if not c: continue
            sym_, exp = c[0], c[1]
        sim.X.clear(); sim.X.update(c2.BOT24)
        cost, steps, _ = sim.walk(t["sym"], t["date"], minute, t["right"], sym_, exp, CAL)
        if cost is None: continue
        out[mode] = (sim.result(cost, steps), (dt.date.fromisoformat(exp) - dt.date.fromisoformat(t["date"])).days)
    return out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = pool.map(one, T, chunksize=8)
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        print(f"\n### {lname}\n\n| Pick | Size | Risk manager | Taken | Refused | Sized down | Account | Worst drop | Days in brake |\n|---|---|---|---|---|---|---|---|---|")
        for mode in MODES:
            rows = [dict(date=t["date"], minute=t["minute"], ret=r[mode][0], dte=r[mode][1]) for t, r in zip(T, R) if lf(t) and mode in r]
            for pct in (0.01, 0.02):
                for rm, lab in RISK:
                    x = ro.run(rows, pct, rm, CAL)
                    print(f"| {mode} | {pct:.0%} | {lab} | {x['taken']} | {x['refused']} | {x['shrunk']} | ${x['end']:,.0f} | {x['dd']:.0%} | {x['brake']} |", flush=True)


if __name__ == "__main__":
    main()
