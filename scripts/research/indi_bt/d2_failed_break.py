"""The D2 bonus entry together with the failed-break sale (the user, 2026-10-25: "is there a place for both D2 and
failed break sale?"; then "go and test it": the failed break only on the
entries that had t >= 1.8, never on the early D2 entries, set before running). The live bot (2.4) is the rest-stop champion's exits plus the failed-break sale; the champion
is the D2 bonus entry with the rest-stop exits and no failed break. Four versions: the two entries (s_t18r15, the
champion's; sg_c12_15, the D2 bonus) times the two exit sets (with and without the failed break). The contracts are
the trade files' own, so only the exits change. Fair list and 151 unseen; 1% / 2% from $100,000.

  python3 ../sma-indi-backtest/scripts/research/indi_bt/d2_failed_break.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import calendar
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account, held

B = "data/local/x/bt"
CAL = calendar()
CHAMP = {**sim.X, **H, **NIGHT, "thesis": {"t": 0.5}, "carry_min_gain": 0.5, "after_half": dict(out=-0.2)}
BOT = {**CHAMP, "failed_break": True}
EXITS = [("no failed break", CHAMP), ("failed break", BOT)]
ENTRIES = [("t >= 1.8", "s_t18r15"), ("D2 bonus", "sg_c12_15")]


def one(t):
    out = {}
    for name, rb in EXITS:
        sim.X.clear(); sim.X.update(rb)
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: return None
        out[name] = sim.result(cost, steps)
        out[name + "#h"] = held(cost, steps)
    pick = "failed break" if float(t["c_t"]) >= 1.8 else "no failed break"
    out["failed break on t >= 1.8 only"], out["failed break on t >= 1.8 only#h"] = out[pick], out[pick + "#h"]
    return (t["entry"], t["date"], t["sym"], t["minute"]), out


def main():
    T = []
    for ename, prefix in ENTRIES:
        E = [dict(t, entry=ename) for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
        nf.features(E)
        T += [t for t in E if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    T.sort(key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(r for r in pool.map(one, T, chunksize=8) if r)
    key = lambda t: (t["entry"], t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        print(f"\n### {lname}\n")
        print("| Entry | Exits | Trades | Winners | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% |\n|---|---|---|---|---|---|---|---|")
        for ename, _ in ENTRIES:
            L = [t for t in T if t["entry"] == ename and lf(t) and key(t) in R]
            for xname in [n for n, _ in EXITS] + ["failed break on t >= 1.8 only"] * (ename == "D2 bonus"):
                rows = [dict(date=t["date"], pnl=str(pt(R[key(t)][xname])), **R[key(t)][xname + "#h"]) for t in L]
                a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
                top = set(sorted(range(len(rows)), key=lambda k: -float(rows[k]["pnl"]))[:5])
                a5, _ = account([r for k, r in enumerate(rows) if k not in top])
                yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
                win = sum(R[key(t)][xname] > 0 for t in L)
                if xname.endswith("only"): print(f"D2 entries at t >= 1.8: {sum(float(t['c_t']) >= 1.8 for t in L)} of {len(L)}")
                print(f"| {ename} | {xname} | {len(L)} | {win} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} |", flush=True)


if __name__ == "__main__":
    main()
