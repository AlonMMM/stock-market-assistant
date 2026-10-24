"""More air unless the thesis breaks (the user's goal, 2026-10-24: "a stop wider of 50% if our thesis is not broken").
The thesis is on the stock: it is broken when the stock closes k S30 units against the entry (its usual 30-minute
move), or past the signal bar's low (a put: high), or when the signal's own t-stat vs SPY x beta (cumulative from the
open, the entry rule's statistic) falls to 0 (or 0.5). With the option stop at -50% instead of -30%. The +10 / +20
checks, the failed break and the overnight hold stay unless the version says "no checks". All the champion's trades
2024-2026, fair list and 151 unseen; 1% / 2% of the start-of-day account from $100,000. sim.py: thesis, user_stop out.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs thesis.py      (from the repo root)
"""
import collections, csv, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import calendar
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = calendar()
X0 = {**sim.X, **H, **NIGHT, "failed_break": True}
V = lambda out, th=None, checks=True: dict(out=out, thesis=th, checks=checks)
VERSIONS = [
    ("Bot today: -30%", V(-0.30)),
    ("-50% alone", V(-0.50)),
    ("-50% + stock 0.5 S30 against", V(-0.50, {"s30": 0.5})),
    ("-50% + stock 1 S30 against", V(-0.50, {"s30": 1.0})),
    ("-50% + stock 1.5 S30 against", V(-0.50, {"s30": 1.5})),
    ("-50% + signal bar broken", V(-0.50, {"bar": True})),
    ("-50% + signal t-stat ≤ 0", V(-0.50, {"t": 0.0})),
    ("-50% + signal t-stat ≤ 0.5", V(-0.50, {"t": 0.5})),
    ("-50% + 1 S30 + bar + t ≤ 0", V(-0.50, {"s30": 1.0, "bar": True, "t": 0.0})),
    ("-30% + 1 S30 + bar + t ≤ 0", V(-0.30, {"s30": 1.0, "bar": True, "t": 0.0})),
    ("No checks, -50% + 1 S30 against", V(-0.50, {"s30": 1.0}, checks=False)),
    ("No checks, -50% + 1 S30 + bar + t ≤ 0", V(-0.50, {"s30": 1.0, "bar": True, "t": 0.0}, checks=False)),
    ("No checks, -50% + t ≤ 0", V(-0.50, {"t": 0.0}, checks=False)),
]


def one(t):
    out = {}
    for name, v in VERSIONS:
        sim.X.clear(); sim.X.update(X0)
        sim.X["user_stop"] = {**X0["user_stop"], "out": v["out"], **({} if v["checks"] else {"checks": []})}
        if v["thesis"]: sim.X["thesis"] = v["thesis"]
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: return None
        out[name] = (sim.result(cost, steps), "|".join(s[5] for s in steps[1:]))
    return (t["date"], t["sym"], t["minute"]), out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(r for r in pool.map(one, T, chunksize=8) if r)
    key = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    for lname, lf in (("fair list (his 40, traded the year before)", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and key(t) in R]
        print(f"\n### {lname}: {len(L)} trades, 2024-2026\n")
        print("| Version | Winners | Per trade at $10K: 2024 / 2025 / 2026 | Without the best 5 (per trade) | At 1%, worst drop | At 2%, worst drop | Sales: thesis / stop / checks / 15:50 / night |\n|---|---|---|---|---|---|---|")
        for name, _ in VERSIONS:
            rows = [dict(date=t["date"], sym=t["sym"], pnl=str(pt(R[key(t)][name][0]))) for t in L]
            pnl = [float(r["pnl"]) for r in rows]
            yr = [st.fmean([float(r["pnl"]) for r in rows if r["date"][:4] == y] or [0]) for y in ("2024", "2025", "2026")]
            wo = sorted(pnl)[:-5]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            c = collections.Counter(r for t in L for r in R[key(t)][name][1].split("|"))
            th = c["T_s30"] + c["T_bar"] + c["T_tstat"]
            print(f"| {name} | {100 * sum(x > 0 for x in pnl) / len(pnl):.0f}% | " + " / ".join(f"{y:+,.0f}" for y in yr)
                  + f" | {sum(wo) / len(L):+,.0f} | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% | {th} / {c['U_out']} / {c['U_check10'] + c['U_check20']} / {c['eod_close']} / {c['eod_carry']} |", flush=True)
        for name, _ in VERSIONS[1:]:
            d = [(pt(R[key(t)][name][0]) - pt(R[key(t)][VERSIONS[0][0]][0]), t) for t in L]
            ch = [x for x in d if abs(x[0]) > 1]
            top = sorted(ch, key=lambda x: -abs(x[0]))[:4]
            print(f"  {name}: {len(ch)} change ({sum(1 for x in ch if x[0] > 0)} better), sum {sum(x[0] for x in d):+,.0f}; biggest: " + ", ".join(f"{t['sym']} {t['date']} {x:+,.0f}" for x, t in top))


if __name__ == "__main__":
    main()
