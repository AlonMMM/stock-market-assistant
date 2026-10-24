"""Summary of the defence study (defence_signals.py -> score_round.py with BT_TAG=d and the champion's exits):
every rule on the fair list and the 151 unseen, in the Backtest Reports shape, against the champion ("base").

  python3 defence_sum.py [rules...]      (from the repo root)
"""
import collections, csv, glob, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("BT_UNIVERSE", "wide")
import news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account
from defence_signals import RULES

B = "data/local/x/bt"
TAG = os.environ.get("BT_TAG", "d")
LISTS = [("fair list (his 40, traded the year before)", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]),
         ("151 unseen", lambda t: t["sym"] not in HIS40)]
YEARS = ("2024", "2025", "2026")


def news(t):
    return t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)


def load(rule):
    """All signal rows of a rule with their trade status; the news filter's features on each."""
    sig = [r for y in YEARS for r in csv.DictReader(open(f"{B}/s_sig_{rule}_{y}.csv"))]
    T = [t for f in glob.glob(f"{B}/s{TAG}_{rule}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f))]
    nf.features(sig)
    by = {(t["date"], t["sym"]): t for t in T}
    for r in sig:
        t = by.get((r["date"], r["sym"]))
        r["status"] = t["status"] if t else "not run"
        r["pnl"] = float(t["pnl"]) if t and t["status"] == "ok" else None
    return sig


def figures(rows):
    """The fixed figures for the rows of one list: funnel, trades, winners, per trade, accounts, drops, without the best 5."""
    kept = [r for r in rows if news(r)]
    T = sorted((r for r in kept if r["status"] == "ok"), key=lambda r: (r["date"], int(r["minute"])))
    if not T: return None
    pnl = [r["pnl"] for r in T]
    yr = {y: [r["pnl"] for r in T if r["date"][:4] == y] for y in YEARS}
    a1, d1 = account([dict(r, pnl=str(r["pnl"])) for r in T]); a2, d2 = account([dict(r, pnl=str(r["pnl"])) for r in T], 0.02)
    top = sorted(T, key=lambda r: -r["pnl"])[:5]
    rest = [r for r in T if r not in top]
    wo1, _ = account([dict(r, pnl=str(r["pnl"])) for r in rest])
    return dict(signals=len(rows), skipped=len(rows) - len(kept), nocontract=sum(1 for r in kept if r["status"] not in ("ok", "no_fill")),
                trades=len(T), win=100 * sum(x > 0 for x in pnl) / len(pnl), per=st.fmean(pnl),
                years={y: (len(v), st.fmean(v) if v else 0.0) for y, v in yr.items()},
                a1=a1, d1=d1, a2=a2, d2=d2, wo_per=st.fmean([r["pnl"] for r in rest]) if rest else 0.0, wo_a1=wo1,
                top=top, T=T)


def main():
    rules = sys.argv[1:] or [r for r in RULES if glob.glob(f"{B}/s{TAG}_{r}_20*.[0-9]_trades.csv")]
    data = {r: load(r) for r in rules}
    for lname, lf in LISTS:
        print(f"\n### {lname}\n")
        print("| Rule | Signals → news → no contract → trades | Winners | Per trade at $10K | 2024 / 2025 / 2026 (n, per trade) | Account at 1%, worst drop | At 2%, worst drop | Without the best 5: per trade, account at 1% |")
        print("|---|---|---|---|---|---|---|---|")
        base = None
        for rule in rules:
            F = figures([r for r in data[rule] if lf(r)])
            if not F: continue
            if rule == "base": base = F
            print(f"| {rule} | {F['signals']} → {F['skipped']} → {F['nocontract']} → {F['trades']} | {F['win']:.0f}% | {F['per']:+,.0f} | "
                  + " / ".join(f"{n} {p:+,.0f}" for n, p in F["years"].values())
                  + f" | ${F['a1']:,.0f}, {100 * F['d1']:.0f}% | ${F['a2']:,.0f}, {100 * F['d2']:.0f}% | {F['wo_per']:+,.0f}, ${F['wo_a1']:,.0f} |", flush=True)
        if base:
            print(f"\nbase best 5: " + ", ".join(f"{r['sym']} {r['date']} {r['pnl']:+,.0f}" for r in base["top"]))
        for rule in rules:
            if rule == "base": continue
            F = figures([r for r in data[rule] if lf(r)])
            if not F: continue
            print(f"{rule} best 5: " + ", ".join(f"{r['sym']} {r['date']} {r['pnl']:+,.0f}" for r in F["top"]))
    # Where the new rules' trades come from: shared with the champion's days or new stock-days.
    if "base" in data:
        bdays = {(r["date"], r["sym"]) for r in data["base"] if r["status"] == "ok" and news(r)}
        print("\n| Rule | Trades | Same stock-days as the champion | New stock-days | Dropped from the champion |\n|---|---|---|---|---|")
        for rule in rules:
            if rule == "base": continue
            days = {(r["date"], r["sym"]) for r in data[rule] if r["status"] == "ok" and news(r)}
            print(f"| {rule} | {len(days)} | {len(days & bdays)} | {len(days - bdays)} | {len(bdays - days)} |")


if __name__ == "__main__":
    main()
