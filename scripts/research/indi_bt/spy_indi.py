"""The falling-day idea on Indi's own trades (the user, 2026-11-07: "Try 1." - an independent sample for spy_down.py /
spy_bar.py). His option trades 2023-2026 from data/local/x/ultrawavetrader-<year>/actions.csv (the hand-built ledger):
one row a trade, opened at its first "open" (ET), return = the trade's realized total / everything he paid for it.
Stocks and ETFs only (no SPX / SPXW / XSP / NDX, no futures), no shorts, no trade whose entry is not shown. SPY's move at
his entry = the last minute close before it vs the prior close. Buckets as in drop_anal; giants = +300% or more on
cost; NO_0DTE=1 drops trades opened on their expiry day (the user: "Filter out 0dte"); and the random-days placebo (as spy_placebo.py) on his sum and giants.

  node --env-file=.env <dir>/run.mjs spy_indi.py
"""
import collections, csv, os, random, re, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import spy_down as SD

X = "data/local/x"
INDEX = {"SPX", "SPXW", "XSP", "NDX", "NDXP", "RUT", "VIX"}


def trades():
    out = []
    for y in (2023, 2024, 2025, 2026):
        by = collections.defaultdict(list)
        for a in csv.DictReader(open(f"{X}/ultrawavetrader-{y}/actions.csv")): by[a["trade"]].append(a)
        for k, A in by.items():
            acts = {a["action"] for a in A}
            if acts & {"short", "add short", "exit (entry not shown)"}: continue
            first = next((a for a in A if a["action"] == "open"), None)
            if not first or not first["time_from"]: continue
            m = re.match(r"(\S+) (\S+) [\d.]+([CP])$", first["contract"])
            if not m or m.group(1) in INDEX: continue
            if os.environ.get("NO_0DTE") and m.group(2) == first["date"]: continue   # the user: "Filter out 0dte"
            cost = sum(float(a["qty"]) * float(a["avg_price"]) * 100 for a in A if a["side"] == "B")
            real = [a["realized_total"] for a in A if a["realized_total"]]
            if not cost or not real: continue
            h, mi, *_ = map(int, first["time_from"].split(":"))
            minute = h * 60 + mi - 570
            if not 0 <= minute < 390: continue
            pnl = float(real[-1])
            out.append(dict(year=y, date=first["date"], minute=minute, und=m.group(1), side=m.group(3), cost=cost, pnl=pnl, ret=pnl / cost,
                            spy=SD.spy_day(first["date"], minute)))
    return out


def row(name, T):
    if not T: return f"| {name} | 0 | | | | | |"
    g = [t for t in T if t["ret"] >= 3]
    return (f"| {name} | {len(T)} | {sum(t['ret'] > 0 for t in T) / len(T):.0%} | {st.median(t['ret'] for t in T):+.0%} | {len(g)} ({len(g) / len(T):.1%}) | "
            f"${sum(t['pnl'] for t in T):+,.0f} | ${sum(t['pnl'] for t in T if t['ret'] < 3):+,.0f} |")


def main():
    T = trades()
    print(f"{len(T)} trades, {T and min(t['date'] for t in T)} .. {max(t['date'] for t in T)}")
    B = [("SPY down 0.75%+", lambda v: v <= -0.0075), ("down 0.5-0.75%", lambda v: -0.0075 < v <= -0.005), ("-0.5% to 0", lambda v: -0.005 < v < 0),
         ("0 to +0.5%", lambda v: 0 <= v < 0.005), ("up 0.5%+", lambda v: v >= 0.005)]
    hdr = "| SPY's move at his entry | Trades | Winners | Median return | Giants (+300%) | Sum | Sum without giants |\n|---|---|---|---|---|---|---|"
    for label, sel in (("all", lambda t: True), ("calls", lambda t: t["side"] == "C"), ("puts", lambda t: t["side"] == "P")):
        print(f"\n### Indi, {label}, 2023-2026\n\n{hdr}")
        for name, f in B: print(row(name, [t for t in T if sel(t) and f(t["spy"])]))
    print(f"\n### By year, SPY down 0.5%+ vs the rest\n\n| Year | Down 0.5%+: trades · giants · sum | The rest: trades · giants · sum |\n|---|---|---|")
    for y in (2023, 2024, 2025, 2026):
        d = [t for t in T if t["year"] == y and t["spy"] <= -0.005]; r = [t for t in T if t["year"] == y and t["spy"] > -0.005]
        f = lambda L: f"{len(L)} · {sum(t['ret'] >= 3 for t in L)} · ${sum(t['pnl'] for t in L):+,.0f}"
        print(f"| {y} | {f(d)} | {f(r)} |")
    # placebo: random days holding as many trades as the falling-day set
    down = [t for t in T if t["spy"] <= -0.005]
    n, gs, ps = len(down), sum(t["ret"] >= 3 for t in down), sum(t["pnl"] for t in down)
    days = sorted({t["date"] for t in T}); per = collections.Counter(t["date"] for t in T)
    random.seed(7); G, P = [], []
    for _ in range(2000):
        random.shuffle(days); pick, c = set(), 0
        for d in days:
            if c >= n: break
            pick.add(d); c += per[d]
        S = [t for t in T if t["date"] in pick]
        G.append(sum(t["ret"] >= 3 for t in S) / max(1, len(S))); P.append(sum(t["pnl"] for t in S) / max(1, len(S)))
    gr = gs / n; pr = ps / n
    print(f"\nPlacebo (2,000 random day sets of ~{n} trades): falling days giant rate {gr:.1%} vs random median {sorted(G)[1000]:.1%} "
          f"(as low or lower {sum(g <= gr for g in G) / len(G):.1%}); $ a trade {pr:+,.0f} vs random median {sorted(P)[1000]:+,.0f} "
          f"(as low or lower {sum(p <= pr for p in P) / len(P):.1%})")


if __name__ == "__main__":
    main()
