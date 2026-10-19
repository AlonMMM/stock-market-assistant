"""Results of a simulated run (sim.py output).

  fixed      every trade at fixed_premium: total, without the best 5/10/20, median, win rate, per year
  costs      the same at spread_half and at 2x spread_half (fills re-priced from the bar middles)
  portfolio  signals in time order, at most max_open at once, premium = equity x risk_pct / risk share
             of the expiry, capped at max_vol_share of the contract's last-30-min volume
  skipped    why signals did not become trades

  python3 report.py [prefix]     (default data/local/x/bt/bot)
"""
import csv, collections, os, statistics as st, sys
from store import P, DATA

S = P["size"]; SH = P["cost"]["spread_half"]


def load(prefix):
    trades = list(csv.DictReader(open(f"{prefix}_trades.csv")))
    steps = collections.defaultdict(list)
    for s in csv.DictReader(open(f"{prefix}_steps.csv")): steps[int(s["id"])].append(s)
    return trades, steps


def ret_at(steps, sh):
    """Return on premium with fills re-priced at half-spread sh."""
    buy = next(s for s in steps if s["side"] == "buy")
    cost = float(buy["price"]) / (1 + SH) * (1 + sh)
    sold, n = 0.0, 0.0
    for s in steps:
        if s["side"] != "sell": continue
        p = float(s["price"])
        if s["rule"] != "expired" and p > 0.01: p = p / (1 - SH) * (1 - sh)
        sold += float(s["share"]) * max(p, 0.0); n += float(s["share"])
    return sold / cost - 1 - S["commission"] / (cost * 100) * (1 + n)


def line(name, R, unit):
    if not R: return f"| {name} | 0 | | | | | | |"
    R = sorted(R)
    tot = sum(R) * unit
    w = lambda k: f"{sum(R[:-k]) * unit:+,.0f}" if len(R) > 2 * k else ""
    return (f"| {name} | {len(R)} | {tot:+,.0f} | {w(5)} | {w(10)} | {w(20)} | "
            f"{st.median(R) * 100:+.0f}% | {100 * sum(r > 0 for r in R) / len(R):.0f}% |")


def risk_share(dte):
    s = S["risk_share"][0][1]
    for d, v in S["risk_share"]:
        if dte >= d: s = v
    return s


def portfolio(ok, rets):
    eq, open_, out, peak, dd = S["start_equity"], [], [], S["start_equity"], 0.0
    for t in sorted(ok, key=lambda t: (t["date"], int(t["minute"]))):
        now = (t["date"], int(t["minute"]))
        for o in [o for o in open_ if (o[0], o[1]) <= now]:
            eq += o[2]; open_.remove(o); peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        if len(open_) >= P["entry"]["max_open"]: out.append(None); continue
        prem = eq * S["risk_pct"] / risk_share(int(t["dte"]))
        n = int(min(prem / (float(t["entry"]) * 100), S["max_vol_share"] * float(t["vol30"])))
        if n < 1: out.append(None); continue
        pnl = n * float(t["entry"]) * 100 * rets[t["_i"]]
        open_.append((t["exit_date"], int(t["exit_minute"]), pnl)); out.append(pnl)
    for o in open_: eq += o[2]
    return eq, out, dd


def main(prefix):
    trades, steps = load(prefix)
    for i, t in enumerate(trades): t["_i"] = i
    ok = [t for t in trades if t["status"] == "ok"]
    rets = {t["_i"]: ret_at(steps[t["_i"]], SH) for t in ok}
    rets2 = {t["_i"]: ret_at(steps[t["_i"]], 2 * SH) for t in ok}
    u = S["fixed_premium"]
    hdr = "| | Trades | Total | w/o best 5 | w/o best 10 | w/o best 20 | Median | Win |\n|---|---|---|---|---|---|---|---|"
    print(f"## Every trade at ${u:,.0f}\n\n{hdr}")
    print(line(f"All, spread {SH:.0%}", [rets[t['_i']] for t in ok], u))
    print(line(f"All, spread {2 * SH:.0%}", [rets2[t['_i']] for t in ok], u))
    for y in sorted({t["date"][:4] for t in ok}):
        print(line(y, [rets[t["_i"]] for t in ok if t["date"][:4] == y], u))
    for name, f in (("Calls", lambda t: t["right"] == "C"), ("Puts", lambda t: t["right"] == "P"),
                    ("Carried overnight", lambda t: t["carried"] == "1"), ("Same day", lambda t: t["carried"] != "1"),
                    ("Entry before 10:30", lambda t: int(t["minute"]) < 60), ("Entry 10:30+", lambda t: int(t["minute"]) >= 60),
                    ("1-2 days to expiry", lambda t: int(t["dte"]) <= 2), ("3-7 days", lambda t: int(t["dte"]) > 2)):
        print(line(name, [rets[t["_i"]] for t in ok if f(t)], u))
    print("\n## Last rule that closed the trade\n\n| Rule | Trades | Avg return |\n|---|---|---|")
    for rule, n in collections.Counter(t["exit_rule"] for t in ok).most_common():
        print(f"| {rule} | {n} | {st.fmean(rets[t['_i']] for t in ok if t['exit_rule'] == rule) * 100:+.0f}% |")
    eq, pnl, dd = portfolio(ok, rets)
    taken = [p for p in pnl if p is not None]
    print(f"\n## Portfolio: {S['risk_pct']:.0%} risk per trade, max {P['entry']['max_open']} open, start ${S['start_equity']:,.0f}\n")
    print(f"Trades taken {len(taken)} of {len(ok)}; end equity ${eq:,.0f} ({eq / S['start_equity'] - 1:+.1%}); worst drawdown {dd:.1%}")
    print("\n## Signals not traded\n\n| Reason | Signals |\n|---|---|")
    for k, n in collections.Counter(t["status"] for t in trades if t["status"] != "ok").most_common():
        print(f"| {k} | {n} |")
    print(f"| traded | {len(ok)} |")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "bot"))
