"""The +10 / +20 minute checks need the option down too (the user's idea, 2026-10-24): "the stock not only needs to be
against the entry but also the option should be worth 10% less than entry". Two readings, with 5 / 10 / 15 / 20%:
  at the check      at +10 (and +20) minutes, sell only if the stock is against the entry AND the option is down that
                    much; a check not met passes (as today, where a check not met passes)
  from the check on the check stays armed from +10 (+20) on and fires at the first minute both hold
Everything else as the bot today (champion + the failed-break sale, the -30% stop with the stock against, the overnight
hold). All the champion's trades 2024-2026, fair list and the 151 unseen; 1% / 2% of the start-of-day account from
$100,000. sim.py: user_stop opt_below / opt_wait.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs opt_check.py      (from the repo root)
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
VERSIONS = [("Bot today", {})]
for p in (5, 10, 15, 20):
    VERSIONS.append((f"At the check, option ≤ -{p}%", {"opt_below": -p / 100}))
    VERSIONS.append((f"From the check on, option ≤ -{p}%", {"opt_below": -p / 100, "opt_wait": True}))


def one(t):
    out = {}
    for name, u in VERSIONS:
        sim.X.clear(); sim.X.update(X0); sim.X["user_stop"] = {**X0["user_stop"], **u}
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
        print("| Version | Winners | Per trade at $10K: 2024 / 2025 / 2026 | Without the best 5 (per trade) | At 1%, worst drop | At 2%, worst drop | Sales: check10 / check20 / out |\n|---|---|---|---|---|---|---|")
        for name, _ in VERSIONS:
            rows = [dict(date=t["date"], sym=t["sym"], pnl=str(pt(R[key(t)][name][0]))) for t in L]
            pnl = [float(r["pnl"]) for r in rows]
            yr = [st.fmean([float(r["pnl"]) for r in rows if r["date"][:4] == y] or [0]) for y in ("2024", "2025", "2026")]
            wo = sorted(pnl)[:-5]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            c = collections.Counter(r for t in L for r in R[key(t)][name][1].split("|"))
            print(f"| {name} | {100 * sum(x > 0 for x in pnl) / len(pnl):.0f}% | " + " / ".join(f"{y:+,.0f}" for y in yr)
                  + f" | {sum(wo) / len(L):+,.0f} | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% | {c['U_check10']} / {c['U_check20']} / {c['U_out']} |", flush=True)
        base = "Bot today"
        for name, _ in VERSIONS[1:]:
            d = [(pt(R[key(t)][name][0]) - pt(R[key(t)][base][0]), t) for t in L]
            ch = [x for x in d if abs(x[0]) > 1]
            top = sorted(ch, key=lambda x: -abs(x[0]))[:4]
            print(f"  {name}: {len(ch)} trades change, sum {sum(x[0] for x in d):+,.0f} at $10K; biggest: " + ", ".join(f"{t['sym']} {t['date']} {x:+,.0f}" for x, t in top))


if __name__ == "__main__":
    main()
