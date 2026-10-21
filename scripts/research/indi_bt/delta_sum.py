"""Bot flat 1% C entries at contract deltas 0.10 - 0.40, sold at 15:50 or with the overnight hold (40 stocks).

  python3 delta_sum.py      (from the repo root; after tiers_round.py runs flat_d*, flat_n100_d*)
"""
import collections, csv, glob, statistics as st

B = "data/local/x/bt"
RUNS = [(d, ex, f"t_flat{'_n100' if ex == 'night' else ''}{'' if d == 15 else f'_d{d}'}") for d in (10, 15, 20, 30, 40) for ex in ("15:50", "night")]


def comp(T, start):
    eq, cur, dp = 2e6, None, 0.0
    for t in sorted((t for t in T if t["date"][:4] >= start), key=lambda t: (t["date"], int(t["minute"]))):
        if t["date"] != cur: eq += dp; dp = 0.0; cur = t["date"]
        dp += 0.015 * eq * max(-1, float(t["pnl"]) / 1e4)
    return (eq + dp) / 2e6 * 100 - 100


print("| Delta | Exit | 2024 | 2025 | 2026 | 2025-26 per trade | Without best 5 a year, 2025 / 2026 | Win | Skipped (no contract) | Compounding 1.5%, 2025-26 |\n|---|---|---|---|---|---|---|---|---|---|")
for d, ex, p in RUNS:
    A = [t for f in sorted(glob.glob(f"{B}/{p}_20*_trades.csv")) for t in csv.DictReader(open(f))]
    T = [t for t in A if t["status"] == "ok"]
    if not T: continue
    yr = {y: [float(t["pnl"]) for t in T if t["date"][:4] == y] for y in ("2024", "2025", "2026")}
    cell = lambda v: f"{len(v)}, {st.fmean(v):+,.0f}" if v else ""
    p56 = yr["2025"] + yr["2026"]
    wo = " / ".join(f"{sum(sorted(yr[y])[:-5])/1e3:+,.0f}K" for y in ("2025", "2026"))
    skip = collections.Counter(t["status"] for t in A if t["status"] != "ok")
    print(f"| {d/100:.2f} | {ex} | {cell(yr['2024'])} | {cell(yr['2025'])} | {cell(yr['2026'])} | {st.fmean(p56):+,.0f} | {wo} | "
          f"{100*sum(x > 0 for x in p56)/len(p56):.0f}% | {sum(skip.values())} ({', '.join(f'{k} {v}' for k, v in skip.most_common(2))}) | {comp(T, '2025'):+.0f}% |")
