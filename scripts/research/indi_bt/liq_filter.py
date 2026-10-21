"""The liquidity filter: take a bot signal only when its 0.10-delta option was tradeable (>= 200 contracts in the
last 30 minutes, >= $0.20), then trade another delta's contract. Results per year, without the best 5, and the
account at 1% of the current account from $100,000.

  python3 liq_filter.py <t|w>      (from the repo root; after tiers_round.py runs flat_d10 and flat_n100_d*)
"""
import csv, glob, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
B = "data/local/x/bt"
HIS40 = set(json.load(open(os.path.join(HERE, "params.json")))["universe"])
TAG = (sys.argv[1:] or ["t"])[0]


def load(p, ok_only=True):
    D = {}
    for f in glob.glob(f"{B}/{p}_20*_trades.csv"):
        for t in csv.DictReader(open(f)):
            if t["status"] == "ok" or not ok_only: D[(t["date"], t["sym"], t["right"], t["minute"])] = t
    return D


def account(T):
    eq, cur, start, peak, dd, yr = 1e5, None, 1e5, 1e5, 0.0, {}
    for k in sorted(T, key=lambda k: (k[0], int(k[3]))):
        if k[0] != cur:
            cur = k[0]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak); yr.setdefault(k[0][:4], eq)
        eq += 0.01 * start * max(-1, float(T[k]["pnl"]) / 1e4)
    dd = max(dd, 1 - eq / max(peak, eq))
    ends = list(yr.values())[1:] + [eq]
    return eq, dd, [e / s - 1 for s, e in zip(yr.values(), ends)]


def main():
    liq = set(load(f"{TAG}_flat_d10"))
    print(f"| Stocks | Version | Trades | 2024 | 2025 | 2026 | Without best 5 (2024 / 2025 / 2026) | Account at 1% | Years | Worst drop |\n|---|---|---|---|---|---|---|---|---|---|")
    groups = [("all", lambda s: True)]
    if TAG == "w": groups = [("all 191", lambda s: True), ("151 unseen", lambda s: s not in HIS40)]
    for gname, gf in groups:
        for d in ("", "_d30", "_d40"):
            for filt in (False, True):
                T = {k: t for k, t in load(f"{TAG}_flat_n100{d}").items() if gf(k[1]) and (not filt or k in liq)}
                if not T: continue
                yr = {y: sorted(float(t["pnl"]) for k, t in T.items() if k[0][:4] == y) for y in ("2024", "2025", "2026")}
                eq, dd, ys = account(T)
                name = f"delta {'0.15' if not d else '0.' + d[2:]} + hold" + (", liquid 0.10 only" if filt else "")
                print(f"| {gname} | {name} | {len(T)} | " + " | ".join(f"{st.fmean(v):+,.0f}" for v in yr.values()) + " | "
                      + " / ".join(f"{sum(v[:-5])/1e3:+,.0f}K" for v in yr.values()) + f" | ${eq:,.0f} | " + " ".join(f"{100*g:+.0f}%" for g in ys) + f" | {100*dd:.0f}% |")


if __name__ == "__main__":
    main()
