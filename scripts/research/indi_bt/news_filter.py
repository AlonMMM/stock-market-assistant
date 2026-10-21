"""V2: earnings and the pre-market as filters on the V1 trades (C signal, your stop + overnight hold, delta 0.15).

Earnings: the reaction day is the report day when it came before the open, the next session when after the close,
otherwise whichever of the two gapped more (as context.py). Report dates are public ahead of time, so "days to the
next report" is no look-ahead. Pre-market (04:00-09:30): volume vs the median of the 20 sessions before, and the
move from yesterday's close to the last pre-market price, in the bet direction.

  python3 news_filter.py [prefix]     (from the repo root; default w_flat_n100)
"""
import bisect, collections, csv, glob, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import day, calendar, db
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
PREFIX = (sys.argv[1:] or ["w_flat_n100"])[0]


def gap(s, d):
    b, pb = day(s, d), day(s, CAL[IDX[d] - 1])
    return abs(b[0][1] / pb[-1][4] - 1) if b and pb else 0


def reactions():
    out = collections.defaultdict(list)
    for s, rows in json.load(open(f"{B}/earnings.json")).items():
        for d, t in rows:
            i = bisect.bisect_left(CAL, d)
            if i >= len(CAL) - 1 or i == 0: continue
            same = CAL[i] if CAL[i] == d else None
            nxt = CAL[i + 1] if same else CAL[i]
            if t == "time-pre-market" and same: r = same
            elif t == "time-after-hours" or not same: r = nxt
            else: r = max((same, nxt), key=lambda x: gap(s, x))
            out[s].append(IDX[r])
    return {s: sorted(set(v)) for s, v in out.items()}


def features(T):
    R = reactions()
    pre = {(r[0], r[1]): (r[2], r[3]) for r in db.execute("SELECT symbol, date, vol, last FROM pre")}
    for t in T:
        s, i = t["sym"], IDX[t["date"]]
        r = R.get(s, []); j = bisect.bisect_left(r, i)
        t["e_next"] = r[j] - i if j < len(r) else 99      # 0 = today is the reaction day
        t["e_last"] = i - r[j - 1] if j > 0 else 99         # 1 = yesterday was
        bet = 1 if t["right"] == "C" else -1
        pv = [pre[(s, CAL[k])][0] for k in range(i - 20, i) if (s, CAL[k]) in pre]
        pr = pre.get((s, t["date"])); pb = day(s, CAL[i - 1])
        t["pre_rvol"] = pr[0] / st.median(pv) if pr and len(pv) >= 10 and st.median(pv) else None
        t["pre_gap"] = bet * (pr[1] / pb[-1][4] - 1) * 100 if pr and pb else None


def earn_bucket(t):
    if t["e_next"] == 0: return "reaction day"
    if t["e_last"] == 1: return "day after"
    if t["e_next"] == 1: return "day before"
    if 2 <= t["e_last"] <= 5: return "2-5 days after"
    if 2 <= t["e_next"] <= 5: return "2-5 days before"
    return "no report within 5 days"


def pre_bucket(t):
    v = t["pre_rvol"]
    if v is None: return "no data"
    if v < 1: return "< 1x"
    if v < 2: return "1-2x"
    if v < 4: return "2-4x"
    return ">= 4x"


def gap_bucket(t):
    g = t["pre_gap"]
    if g is None: return "no data"
    if g <= -1: return "against >= 1%"
    if g < 1: return "within 1%"
    if g < 3: return "our way 1-3%"
    return "our way >= 3%"


FILTERS = [
    ("V1, every trade", lambda t: True),
    ("skip the reaction day", lambda t: t["e_next"] != 0),
    ("skip the reaction day and the day after", lambda t: t["e_next"] != 0 and t["e_last"] != 1),
    ("skip the day before (no overnight into the report)", lambda t: t["e_next"] != 1),
    ("skip 1 day before to 1 day after", lambda t: t["e_next"] > 1 and t["e_last"] > 1),
    ("skip pre-market volume >= 4x", lambda t: t["pre_rvol"] is None or t["pre_rvol"] < 4),
    ("only pre-market volume < 2x (quiet opens)", lambda t: t["pre_rvol"] is not None and t["pre_rvol"] < 2),
    ("skip a pre-market move against >= 1%", lambda t: t["pre_gap"] is None or t["pre_gap"] > -1),
    ("skip a pre-market move our way >= 3%", lambda t: t["pre_gap"] is None or t["pre_gap"] < 3),
    ("no earnings ±1 day and pre-market < 4x", lambda t: t["e_next"] > 1 and t["e_last"] > 1 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)),
]


def line(lab, T, base=None):
    yr = {y: sorted(float(t["pnl"]) for t in T if t["date"][:4] == y) for y in ("2024", "2025", "2026")}
    eq, dd = account(T)
    half = f" | ${account(base, 0.005 * len(base) / max(len(T), 1) * len(T) / len(base))[0]:,.0f}" if base is not None else ""
    print(f"| {lab} | {len(T)} | " + " | ".join(f"{len(v)}, {st.fmean(v):+,.0f}" if v else "" for v in yr.values())
          + " | " + " / ".join(f"{sum(v[:-5]) / 1e3:+,.0f}K" for v in yr.values()) + f" | ${eq:,.0f} | {100 * dd:.0f}% |")


def main():
    T = sorted((t for f in glob.glob(f"{B}/{PREFIX}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
               key=lambda t: (t["date"], int(t["minute"])))
    features(T)
    lists = [("fair list", [t for t in T if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]),
             ("151 unseen", [t for t in T if t["sym"] not in HIS40])]
    head = "| {} | Trades | 2024 (n, per trade) | 2025 | 2026 | Without best 5 (24 / 25 / 26) | Account at 1% | Worst drop |\n|---|---|---|---|---|---|---|---|"
    for lname, L in lists:
        print(f"\n## {lname} ({PREFIX})")
        for title, fn in (("Earnings", earn_bucket), ("Pre-market volume", pre_bucket), ("Pre-market move our way", gap_bucket)):
            print(f"\n{head.format(title)}")
            groups = collections.defaultdict(list)
            for t in L: groups[fn(t)].append(t)
            for k, v in sorted(groups.items(), key=lambda kv: -len(kv[1])): line(k, v)
        print(f"\n{head.format('Filter')}")
        for lab, f in FILTERS: line(lab, [t for t in L if f(t)])


if __name__ == "__main__":
    main()
