"""V2: false alarms. The C signal measures strength vs SPY x beta, so a stock that falls with SPY, only less than SPY x
beta, still looks strong; with a volume jump it fires a call on a falling stock (a put on a rising one the other way).
At the signal minute, in the bet direction:
  own_open   the stock's own move since the open, %          (no SPY in it)
  own_prev   the stock's own move since yesterday's close, %
  own15      the stock's own move over the last 15 minutes, %
  spy_open   SPY's move since the open, %                     (negative = against the bet)
  spy15      SPY's move over the last 15 minutes, %
Filters skip a trade when the stock itself goes against the bet, or when the market does. On the champion's trades
(V1) and on score >= 2.5, fair list and 151 unseen, 1% of the current account from $100,000.

  python3 false_alarm.py      (from the repo root)
"""
import csv, glob, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import day, calendar
from signals import series
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}


def features(t):
    m, bet = int(t["minute"]), 1 if t["right"] == "C" else -1
    bars = day(t["sym"], t["date"]); pb = day(t["sym"], CAL[IDX[t["date"]] - 1])
    c = series(bars)[0]; s = series(day("SPY", t["date"]))[0]
    o, so = bars[0][1], next((x for x in s if x), None)
    mv = lambda a, b: bet * (a / b - 1) * 100 if a and b else 0.0
    t.update(own_open=mv(c[m], o), own_prev=mv(c[m], pb[-1][4]) if pb else 0.0, own15=mv(c[m], c[max(0, m - 15)]),
             spy_open=mv(s[m], so), spy15=mv(s[m], s[max(0, m - 15)]))


FILTERS = [
    ("no filter", lambda t: True),
    ("stock itself up since the open (our way)", lambda t: t["own_open"] > 0),
    ("stock itself our way since yesterday's close", lambda t: t["own_prev"] > 0),
    ("stock itself our way over the last 15 min", lambda t: t["own15"] > 0),
    ("both: since the open and last 15 min", lambda t: t["own_open"] > 0 and t["own15"] > 0),
    ("SPY not against us since the open by >= 0.3%", lambda t: t["spy_open"] > -0.3),
    ("SPY not against us over the last 15 min by >= 0.2%", lambda t: t["spy15"] > -0.2),
    ("skip: stock against us AND SPY against us since the open", lambda t: not (t["own_open"] <= 0 and t["spy_open"] < 0)),
    ("skip: stock and SPY both against us over the last 15 min", lambda t: not (t["own15"] <= 0 and t["spy15"] < 0)),
    # the other reading: the stock moves with the market, both our way, so the move is SPY's, not the stock's
    ("skip: SPY our way since the open by >= 0.3%", lambda t: t["spy_open"] < 0.3),
    ("skip: SPY our way since the open by >= 0.5%", lambda t: t["spy_open"] < 0.5),
    ("skip: SPY our way over the last 15 min by >= 0.2%", lambda t: t["spy15"] < 0.2),
    ("skip: stock's own move < 2x SPY's, both our way", lambda t: not (t["spy_open"] > 0 and t["own_open"] < 2 * t["spy_open"])),
]


def line(lab, T, base):
    yr = {y: sorted(float(t["pnl"]) for t in T if t["date"][:4] == y) for y in ("2024", "2025", "2026")}
    eq, dd = account(T)
    skipped = [t for t in base if t not in T]
    sk = f"{len(skipped)}, {st.fmean(float(t['pnl']) for t in skipped):+,.0f}" if skipped else ""
    print(f"| {lab} | {len(T)} | {sk} | " + " / ".join(f"{st.fmean(v):+,.0f}" if v else "" for v in yr.values())
          + f" | ${eq:,.0f} | {100 * dd:.0f}% |")


def main():
    lists = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)]
    for name, prefix in (("V1", "w_flat_n100"), ("score >= 2.5", "s_s25")):
        T = sorted((t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
                   key=lambda t: (t["date"], int(t["minute"])))
        for t in T: features(t)
        for lname, lf in lists:
            L = [t for t in T if lf(t)]
            fa = [t for t in L if t["own_open"] <= 0]
            print(f"\n### {name}, {lname}: {len(L)} trades; {len(fa)} with the stock itself against the bet since the open "
                  f"({st.fmean(float(t['pnl']) for t in fa):+,.0f} a trade vs {st.fmean(float(t['pnl']) for t in L if t not in fa):+,.0f} for the rest)\n")
            print("| Filter | Trades | Skipped: n, per trade | Per trade 2024 / 2025 / 2026 | Account at 1% | Worst drop |\n|---|---|---|---|---|---|")
            for lab, f in FILTERS: line(lab, [t for t in L if f(t)], L)


if __name__ == "__main__":
    main()
