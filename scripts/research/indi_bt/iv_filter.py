"""V2: trade only when implied vol is low. The overnight-hold runs filtered to the lower (or upper) half of IV,
three ways, none of them looking ahead:

  own     the contract's IV at entry vs the same stock's earlier entries (at least 8 before it): IV rank
  cross   the contract's IV vs every entry of the 60 days before it: low-IV stocks
  iv/rv   IV / the stock's 20-day realized vol vs every entry of the 60 days before it: cheap options

Account at 1% of the current account from $100,000, on the fair list (stocks he traded the year before) and on
the 151 unseen stocks.

  python3 iv_filter.py      (from the repo root)
"""
import bisect, csv, datetime as dt, glob, json, math, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import day, calendar

B = "data/local/x/bt"
HIS40 = set(json.load(open(os.path.join(HERE, "params.json")))["universe"])
CAL = calendar()


def his_tickers(y):
    return {r["contract"].split()[0] for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")) if r["account"] == "silexx" and r["action"] == "open"}


PRIOR = {"2024": his_tickers("2023"), "2025": his_tickers("2024"), "2026": his_tickers("2025")}
_rv = {}


def realized(sym, date):
    """Annualized vol of the 20 daily closes before `date` (close to close)."""
    if (sym, date) not in _rv:
        i = CAL.index(date)
        px = [b[-1][4] for b in (day(sym, d) for d in CAL[max(0, i - 21):i]) if b]
        r = [math.log(b / a) for a, b in zip(px, px[1:])]
        _rv[(sym, date)] = st.pstdev(r) * math.sqrt(252) if len(r) >= 15 else None
    return _rv[(sym, date)]


def load(p):
    T = [t for f in glob.glob(f"{B}/{p}_20*_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok" and t["iv"]]
    T.sort(key=lambda t: (t["date"], int(t["minute"])))
    for t in T:
        t["_iv"] = float(t["iv"]); rv = realized(t["sym"], t["date"])
        t["_ivrv"] = t["_iv"] / rv if rv else None
    return T


def rank(T):
    """Adds each trade's lower/upper half under the three ways (None when there is no history yet)."""
    seen = {}
    for i, t in enumerate(T):
        prev = seen.setdefault(t["sym"], [])
        t["own"] = (t["_iv"] <= st.median(prev)) if len(prev) >= 8 else None
        prev.append(t["_iv"])
        d0 = (dt.date.fromisoformat(t["date"]) - dt.timedelta(days=60)).isoformat()
        win = [u for u in T[:i] if d0 <= u["date"] < t["date"]]
        t["cross"] = (t["_iv"] <= st.median(u["_iv"] for u in win)) if len(win) >= 30 else None
        w2 = [u["_ivrv"] for u in win if u["_ivrv"]]
        t["iv/rv"] = (t["_ivrv"] <= st.median(w2)) if t["_ivrv"] and len(w2) >= 30 else None


def account(T):
    eq, cur, start, peak, dd = 1e5, None, 1e5, 1e5, 0.0
    for t in T:
        if t["date"] != cur:
            cur = t["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        eq += 0.01 * start * max(-1, float(t["pnl"]) / 1e4)
    return eq, max(dd, 1 - eq / max(peak, eq))


def row(name, T):
    yr = {y: sorted(float(t["pnl"]) for t in T if t["date"][:4] == y) for y in ("2024", "2025", "2026")}
    eq, dd = account(T)
    cells = " | ".join(f"{len(v)}, {st.fmean(v):+,.0f}" if v else "" for v in yr.values())
    wo = " / ".join(f"{sum(v[:-5]) / 1e3:+,.0f}K" for v in yr.values())
    print(f"| {name} | {len(T)} | {cells} | {wo} | ${eq:,.0f} | {100 * dd:.0f}% |")


def main():
    lists = [("fair list", "t", lambda t: t["sym"] in PRIOR[t["date"][:4]] and t["sym"] in HIS40),
             ("151 unseen", "w", lambda t: t["sym"] not in HIS40)]
    for d in ("", "_d10"):
        for lname, tag, lf in lists:
            T = load(f"{tag}_flat_n100{d}")
            if not T: continue
            rank(T)
            T = [t for t in T if lf(t)]
            dl = "0.10" if d else "0.15"
            print(f"\n### {lname}, delta {dl}\n")
            print("| Version | Trades | 2024 (n, per trade) | 2025 | 2026 | Without best 5 (24 / 25 / 26) | Account at 1% | Worst drop |\n|---|---|---|---|---|---|---|---|")
            row("all (V1)", T)
            for way in ("own", "cross", "iv/rv"):
                row(f"{way}: lower half", [t for t in T if t[way] is True])
                row(f"{way}: upper half", [t for t in T if t[way] is False])
                row(f"{way}: no history yet", [t for t in T if t[way] is None])


if __name__ == "__main__":
    main()
