"""The 151 unseen narrowed to stocks whose options trade (the user, 2026-10-25: "filter them out and use only those
with traded options"). Active = the share of the stock's signals (after the news filter, with a contract decision:
bought, no fill, too cheap, illiquid) whose 0.15-delta contract passed both floors ($0.20, 200 contracts in 30
minutes). The fair list's median is 30%. Main cut 10% (18 stocks), set before running; 5% beside it. A liquidity
measure over the whole period (not P&L). The live bot 2.4 with cheap_up2.py's picks.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs active_unseen.py      (from the repo root)
"""
import collections, csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import cheap_up2 as c2
import news_filter as nf
from low_delta import HIS40
from score_sum import account

B = "data/local/x/bt"


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f))]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    by = collections.defaultdict(collections.Counter)
    for t in T:
        if t["status"] in ("ok", "no_fill", "too_cheap", "illiquid"): by[t["sym"]][t["status"]] += 1
    rate = {s: (c["ok"] + c["no_fill"]) / sum(c.values()) for s, c in by.items()}
    T = sorted((t for t in T if t["status"] in ("ok", "too_cheap", "illiquid") and t["sym"] not in HIS40), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = pool.map(c2.one, T, chunksize=8)
    pt = lambda x: 1e4 * max(-1, x)
    for cut in (0.10, 0.05):
        keep = sorted(s for s in rate if s not in HIS40 and rate[s] >= cut)
        L = [(t, r[1]) for t, r in zip(T, R) if t["sym"] in keep]
        print(f"\n### unseen with options trading, {cut:.0%}+ of signals tradeable: {len(keep)} stocks\n{', '.join(keep)}\n")
        print("| Pick | Trades | Winners | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Added: n, winners, sum | Added without their best 5 |\n|---|---|---|---|---|---|---|---|---|")
        for mode in c2.MODES:
            rows = [dict(date=t["date"], pnl=str(pt(r[mode])), added=t["status"] != "ok", **r[mode + "#h"])
                    for t, r in L if mode in r]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            top = set(sorted(range(len(rows)), key=lambda i: -float(rows[i]["pnl"]))[:5])
            a5, _ = account([r for i, r in enumerate(rows) if i not in top])
            yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            add = sorted((float(r["pnl"]) for r in rows if r["added"]), reverse=True)
            ad = f"{len(add)}, {sum(x > 0 for x in add)}, {sum(add) / 1e3:+,.0f}K" if add else ""
            wo = f"{sum(add[5:]) / 1e3:+,.0f}K" if add else ""
            print(f"| {mode} | {len(rows)} | {sum(float(r['pnl']) > 0 for r in rows)} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {ad} | {wo} |", flush=True)


if __name__ == "__main__":
    main()
