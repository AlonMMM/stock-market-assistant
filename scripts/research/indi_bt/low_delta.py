"""Deltas 0.10 - 0.25 with the overnight hold: every signal vs liquid 0.10 only, on all 40 stocks and on the stocks
he traded the year before (no look-ahead in the list). Account at 1% of the current account from $100,000.

  python3 low_delta.py [t|w]      (from the repo root)
"""
import csv, glob, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
B = "data/local/x/bt"
HIS40 = set(json.load(open(os.path.join(HERE, "params.json")))["universe"])
TAG = (sys.argv[1:] or ["t"])[0]


def his_tickers(y):
    return {r["contract"].split()[0] for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")) if r["account"] == "silexx" and r["action"] == "open"}


PRIOR = {"2024": his_tickers("2023"), "2025": his_tickers("2024"), "2026": his_tickers("2025")}


def load(p):
    D = {}
    for f in glob.glob(f"{B}/{p}_20*_trades.csv"):
        for t in csv.DictReader(open(f)):
            if t["status"] == "ok": D[(t["date"], t["sym"], t["right"], t["minute"])] = t
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
    lists = [("stocks he traded the year before", lambda k: k[1] in PRIOR[k[0][:4]] and k[1] in HIS40)]
    if TAG == "w": lists.append(("151 unseen", lambda k: k[1] not in HIS40))
    print("| Stocks | Delta | Signals | Trades | 2024 | 2025 | 2026 | Without best 5 (24 / 25 / 26) | Account at 1% | Years | Worst drop |\n|---|---|---|---|---|---|---|---|---|---|---|")
    for lname, lf in lists:
        for d in ("_d10", "", "_d20", "_d25"):
            T0 = load(f"{TAG}_flat_n100{d}")
            if not T0: continue
            for filt in (False, True):
                T = {k: t for k, t in T0.items() if lf(k) and (not filt or k in liq)}
                if not T: continue
                yr = {y: sorted(float(t["pnl"]) for k, t in T.items() if k[0][:4] == y) for y in ("2024", "2025", "2026")}
                eq, dd, ys = account(T)
                dl = "0.15" if not d else "0." + d[2:]
                print(f"| {lname} | {dl} | {'liquid 0.10 only' if filt else 'every signal'} | {len(T)} | " + " | ".join(f"{st.fmean(v):+,.0f}" for v in yr.values())
                      + " | " + " / ".join(f"{sum(v[:-5])/1e3:+,.0f}K" for v in yr.values()) + f" | ${eq:,.0f} | " + " ".join(f"{100*g:+.0f}%" for g in ys) + f" | {100*dd:.0f}% |")


if __name__ == "__main__":
    main()
