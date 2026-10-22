"""V2: no trade when the contract's implied vol at entry is at or above a cap (100% and nearby), on the champion
(t >= 1.8, volume >= 1.5x, news filter, your stop + the overnight hold). Delta 0.15 and 0.10, the fair list and
the 151 unseen stocks, 1% and 2% of the current account from $100,000.

  python3 iv_cap.py      (from the repo root; after score_round.py for t18r15)
"""
import csv, glob, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAPS = (None, 2.0, 1.5, 1.2, 1.0, 0.8)
LISTS = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]),
         ("151 unseen", lambda t: t["sym"] not in HIS40)]


def news(t):
    return t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)


def main():
    for prefix, dl in (("s_t18r15", "0.15"), ("sd10_t18r15", "0.10")):
        T = sorted((t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
                   key=lambda t: (t["date"], int(t["minute"])))
        nf.features(T)
        for lname, lf in LISTS:
            L = [t for t in T if lf(t) and news(t)]
            print(f"\n### {lname}, delta {dl}\n")
            print("| IV cap | Trades | Cut | Cut trades per trade | 2024 / 2025 / 2026 per trade | Without best 5 (24 / 25 / 26) | At 1% | At 2% |\n|---|---|---|---|---|---|---|---|")
            for cap in CAPS:
                keep = [t for t in L if cap is None or not t["iv"] or float(t["iv"]) < cap]
                cut = [float(t["pnl"]) for t in L if t not in keep]
                yr = {y: sorted(float(t["pnl"]) for t in keep if t["date"][:4] == y) for y in ("2024", "2025", "2026")}
                a1, d1 = account(keep); a2, d2 = account(keep, 0.02)
                lab = "none (champion)" if cap is None else f"under {cap:.0%}"
                cpt = f"{st.fmean(cut):+,.0f}" if cut else ""
                print(f"| {lab} | {len(keep)} | {len(cut)} | {cpt} | " + " / ".join(f"{st.fmean(v):+,.0f}" for v in yr.values())
                      + " | " + " / ".join(f"{sum(v[:-5]) / 1e3:+,.0f}K" for v in yr.values())
                      + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |")


if __name__ == "__main__":
    main()
