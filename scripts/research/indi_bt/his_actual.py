"""His real results per year (main account), on the bot's stocks: per trade in his dollars, and his return on
the premium he paid scaled to $10K a trade (the bot's flat 1%), with and without his best 5.

  python3 his_actual.py [narrow|wide]
"""
import collections, csv, json, os, statistics as st, sys

HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, "params.json")))
UNI = set(P["universe_wide"] if (sys.argv[1:] or ["narrow"])[0] == "wide" else P["universe"])
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}


def trades(y):
    a, b = SPAN[y]; T = collections.OrderedDict()
    for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
        if r["account"] != "silexx": continue
        und, exp, sr = r["contract"].rsplit(" ", 2)
        if und not in UNI or sr.endswith("S") or not (a <= r["date"] <= b): continue
        t = T.setdefault(r["trade"], dict(cost=0.0, pnl=0.0, opened=False))
        if r["action"] == "open": t["opened"] = True
        if r["side"] == "B": t["cost"] += float(r["qty"]) * float(r["avg_price"]) * 100
        if r["realized_step"]: t["pnl"] += float(r["realized_step"])
    return [t for t in T.values() if t["opened"] and t["cost"] > 0]


if __name__ == "__main__":
    print("| Year | His trades | His P&L | His per trade | His return a trade, at $10K | at $10K w/o best 5 | Win |\n|---|---|---|---|---|---|---|")
    for y in SPAN:
        T = trades(y)
        R = sorted(t["pnl"] / t["cost"] for t in T)
        print(f"| {y} | {len(T)} | {sum(t['pnl'] for t in T)/1e3:+,.0f}K | {st.fmean(t['pnl'] for t in T):+,.0f} | {1e4*st.fmean(R):+,.0f} "
              f"| {1e4*sum(R[:-5])/1e3:+,.0f}K total | {100*sum(r > 0 for r in R)/len(R):.0f}% |")
