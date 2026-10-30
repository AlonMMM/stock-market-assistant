"""Every signal and why it was not traded (the user, 2026-10-31: "can you sho me all the skip we have with their reasons").
The champion's main signals (sg_c12_15, the first signal a stock a day), fair list: each filter in the order the backtest
applies it, then the contract pick (thin_dist.csv). Prints the funnel, by year and by time.

  node --env-file=.env <dir>/run.mjs skip_funnel.py      (after thin_dist.py)
"""
import collections as C, csv, glob, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import news_filter as nf
import real_bench as RB
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"


def main():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f))]
    nf.features(T)
    pick = {(r["sym"], r["date"], r["right"], r["minute"]): r["state"] for r in csv.DictReader(open(f"{B}/thin_dist.csv")) if r["src"] == "fair"}
    why = []
    for t in T:
        if t["date"] > RB.LAST: r = "after the real-quote data ends"
        elif t["sym"] not in HIS40: r = "not one of Indi's 40 stocks"
        elif t["sym"] not in PRIOR[t["date"][:4]]: r = "Indi did not trade the stock the year before"
        elif t["status"] == "no_expiry": r = "no expiry 1-4 days out"
        elif t["status"] in ("no_prices", "no_strikes"): r = "no option prices"
        elif t["status"] == "no_fill": r = "no fill"
        elif t["e_next"] == 0: r = "earnings tonight or next morning"
        elif t["pre_rvol"] is not None and t["pre_rvol"] >= 4: r = "news: volume 4x+ before the signal"
        else:
            s = pick.get((t["sym"], t["date"], t["right"], t["minute"]), "?")
            r = {"ok": "TRADED", "thin": "thin: under 200 contracts in 30 min", "cheap": "option under $0.20 ($0.10 IBIT)"}.get(s, "pick not found")
        why.append((t, r))
    n = len(why)
    print(f"{n} signals (first a stock a day), {why[0][0]['date'] if why else ''} ..")
    cnt = C.Counter(r for _, r in why)
    for r, k in cnt.most_common(): print(f"| {r} | {k:,} | {k / n:.0%} |")
    stage = [(t, r) for t, r in why if r not in ("after the real-quote data ends", "not one of Indi's 40 stocks", "Indi did not trade the stock the year before")]
    print(f"\non the fair list: {len(stage)}")
    for r, k in C.Counter(r for _, r in stage).most_common(): print(f"| {r} | {k:,} | {k / len(stage):.0%} |")
    print("\nby year")
    for y in ("2024", "2025", "2026"):
        S = [r for t, r in stage if t["date"][:4] == y]
        c = C.Counter(S); print(y, len(S), {k: f"{v / len(S):.0%}" for k, v in c.most_common()})
    print("\nby stock: traded / thin / cheap / earnings / news / no expiry")
    by = C.defaultdict(C.Counter)
    for t, r in stage: by[t["sym"]][r] += 1
    for s, c in sorted(by.items(), key=lambda x: -sum(x[1].values())):
        tot = sum(c.values())
        print(s, tot, c["TRADED"], c["thin: under 200 contracts in 30 min"], c["option under $0.20 ($0.10 IBIT)"], c["earnings tonight or next morning"], c["news: volume 4x+ before the signal"], c["no expiry 1-4 days out"] + c["no option prices"] + c["no fill"])


if __name__ == "__main__":
    main()
