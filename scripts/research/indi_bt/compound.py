"""Compounding comparison: every strategy starts at $2M and sizes each trade as a % of the CURRENT account,
the way he does (0.5-2.5% of his portfolio). Trades are applied in date/minute order; a trade's P&L joins the
account at the end of its entry day.

  his_pct    his entries + your stop, each at HIS opening cost / his account then (account = $2.01M on
             2024-01-01 + his realized P&L since, all tickers; taxes and withdrawals are not known)
  his_15     his entries + your stop, each at 1.5%
  bot_*      the bot's runs, flat at 1.5%, or tiers C/B/A = 0.5% / 1% / 2.5% (adds and roll at their own share)
  real       his real dollars on the same stocks (no model)

  python3 compound.py [tag] [years...]      (from the repo root)
"""
import collections, csv, glob, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import report

B = "data/local/x/bt"
P = json.load(open(os.path.join(HERE, "params.json")))
U = set(P["universe"])
TAG = (sys.argv[1:] or ["t"])[0]
YEARS = sys.argv[2:] or ["2024", "2025", "2026"]
START = 2_000_000


def his_trades():
    """{trade id: (date, open cost)} on the 40 stocks, and the daily realized P&L of all his trades."""
    opens, daily = {}, collections.defaultdict(float)
    for y in ("2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx": continue
            if r["realized_step"]: daily[r["date"]] += float(r["realized_step"])
            if r["action"] == "open" and r["trade"] not in opens:
                opens[r["trade"]] = (r["date"], float(r["qty"]) * float(r["avg_price"]) * 100, r["contract"].split()[0])
    return opens, daily


def account_on(daily):
    days = sorted(daily); acct, eq = {}, 2_010_000.0
    for d in days: acct[d] = eq; eq += daily[d]
    return lambda d: next((acct[x] for x in reversed(days) if x <= d), 2_010_000.0)


def run(events):
    """events: [(date, minute, pct, ret)] -> final account, max drawdown %."""
    eq, peak, dd, day_pnl, cur = START, START, 0.0, 0.0, None
    for d, m, pct, ret in sorted(events):
        if d != cur:
            eq += day_pnl; day_pnl = 0.0; cur = d
            peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        day_pnl += pct * eq * ret
    eq += day_pnl; dd = max(dd, 1 - eq / max(peak, eq))
    return eq, dd


def main():
    opens, daily = his_trades()
    acct = account_on(daily)
    his_ev_pct, his_ev_15, pcts = [], [], []
    for y in YEARS:
        T, S, _ = report.load(f"{B}/t_his_{y}")
        ret = {(t["date"], t["sym"], t["minute"]): report.ret_at(S[t["_i"]], report.SH) for t in T if t["status"] == "ok"}
        for h in csv.DictReader(open(f"{B}/t_sig_his_{y}.csv")):
            k = (h["date"], h["sym"], h["minute"])
            if k not in ret or h["his_trade"] not in opens: continue
            d, cost, _ = opens[h["his_trade"]]
            pct = cost / acct(d); pcts.append(pct)
            his_ev_pct.append((h["date"], int(h["minute"]), pct, ret[k]))
            his_ev_15.append((h["date"], int(h["minute"]), 0.015, ret[k]))
    real = sum(p for d, p in daily.items() if d[:4] in YEARS)  # all tickers, for scale
    real40 = 0.0
    for y in YEARS:
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] == "silexx" and r["realized_step"] and r["contract"].split()[0] in U: real40 += float(r["realized_step"])
    rows = [(f"His entries + your stop, at his own size (median {100 * st.median(pcts):.1f}%)", his_ev_pct),
            ("His entries + your stop, 1.5% each", his_ev_15)]
    for name, lab in (("flat", "Bot: flat C entries, 1.5% each"), ("noroll", "Bot: tiers + adds, 0.5/1/2.5%"),
                      ("full", "Bot: tiers + adds + roll, 0.5/1/2.5%"), ("astart", "Bot: A at the first minute, 2.5%"), ("atA", "Bot: enter when A comes, 2.5%")):
        ev = []
        for y in YEARS:
            for f in glob.glob(f"{B}/{TAG}_{name}_{y}.[0-9]_trades.csv"):
                for t in csv.DictReader(open(f)):
                    if t["status"] != "ok": continue
                    r_ = float(t["pnl"]) / float(t["premium"])
                    if name == "flat": pct = 0.015
                    else: pct = min(float(t["premium"]) / 1e6 * (2.5 / 3 if t["top_tier"] == "A" else 1), 0.025)
                    ev.append((t["date"], int(t["minute"]), pct, r_))
        rows.append((lab, ev))
    print(f"Start ${START/1e6:.1f}M, {', '.join(YEARS)}, 40 stocks, your stop\n")
    print("| Strategy | Trades | End account | Gain | Worst drawdown |\n|---|---|---|---|---|")
    for lab, ev in rows:
        eq, dd = run(ev)
        print(f"| {lab} | {len(ev)} | ${eq/1e6:,.2f}M | {100*(eq/START-1):+.0f}% | {100*dd:.0f}% |")
    print(f"| His real P&L on these 40 stocks (his dollars, not compounded here) | | | {real40/1e6:+.2f}M | |")
    print(f"| His real P&L, all tickers | | | {real/1e6:+.2f}M | |")
    q = sorted(pcts)
    print(f"\nhis opening size per trade: p10 {100*q[len(q)//10]:.1f}%, median {100*st.median(q):.1f}%, p90 {100*q[9*len(q)//10]:.1f}%")


if __name__ == "__main__":
    main()
