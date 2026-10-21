"""V2 score rules vs V1, overnight hold, delta 0.15, 1% of the current account from $100,000.

  python3 score_sum.py      (from the repo root; after score_round.py)
"""
import csv, glob, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
RUNS = [("v1", "w_flat_n100", "V1: t ≥ 2 and day volume ≥ 1.5×"),
        ("t3r1", "s_t3r1", "t ≥ 3, volume ≥ 1×"), ("t25r12", "s_t25r12", "t ≥ 2.5, volume ≥ 1.2×"),
        ("t15r25", "s_t15r25", "t ≥ 1.5, volume ≥ 2.5×"),
        ("s20", "s_s20", "score ≥ 2.0"), ("s25", "s_s25", "score ≥ 2.5"), ("s30", "s_s30", "score ≥ 3.0"),
        ("m20", "s_m20", "moving volume blend ≥ 2.0"), ("m25", "s_m25", "moving volume blend ≥ 2.5"),
        ("b20", "s_b20", "speeding-up boost ≥ 2.0"), ("b25", "s_b25", "speeding-up boost ≥ 2.5"),
        ("t2or5x3", "s_t2or5x3", "V1, or t ≥ 2 with a 3× 5-min burst")]
LISTS = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]),
         ("151 unseen", lambda t: t["sym"] not in HIS40)]


def account(T, pct=0.01):
    eq, cur, start, peak, dd = 1e5, None, 1e5, 1e5, 0.0
    for t in T:
        if t["date"] != cur:
            cur = t["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        eq += pct * start * max(-1, float(t["pnl"]) / 1e4)
    return eq, max(dd, 1 - eq / max(peak, eq))


def main():
    for lname, lf in LISTS:
        print(f"\n### {lname}\n")
        print("| Rule | Signals | Trades | 2024 (n, per trade) | 2025 | 2026 | Without best 5 (24 / 25 / 26) | Win | Account at 1% | Worst drop |\n|---|---|---|---|---|---|---|---|---|---|")
        for key, p, lab in RUNS:
            A = [t for f in glob.glob(f"{B}/{p}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if lf(t)]
            T = sorted((t for t in A if t["status"] == "ok"), key=lambda t: (t["date"], int(t["minute"])))
            if not T: continue
            yr = {y: sorted(float(t["pnl"]) for t in T if t["date"][:4] == y) for y in ("2024", "2025", "2026")}
            eq, dd = account(T)
            pnl = [float(t["pnl"]) for t in T]
            print(f"| {lab} | {len(A)} | {len(T)} | " + " | ".join(f"{len(v)}, {st.fmean(v):+,.0f}" for v in yr.values())
                  + " | " + " / ".join(f"{sum(v[:-5]) / 1e3:+,.0f}K" for v in yr.values())
                  + f" | {100 * sum(x > 0 for x in pnl) / len(pnl):.0f}% | ${eq:,.0f} | {100 * dd:.0f}% |")


if __name__ == "__main__":
    main()
