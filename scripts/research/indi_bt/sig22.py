"""The champion's signals in 2022-2023, next to 2024-2026 (the user, 2026-10-31: "why i cant run the backtest in 2022?"
then "OK give me signals for 2022-2023"). No option prices exist before Feb 2024 here, so this is the stock side only.

The champion's entry rule c12_15 (defence_signals.py: t >= 1.8, or t >= 1.2 and D2 >= 1.5; day volume >= 1.5x; 09:40-15:44;
the first minute per stock and day), on his 40 + the 60 Favorites (75 stocks), every year Jan 2022 - Oct 2026 the same
way. The news filter (no earnings reaction day, pre-market volume < 4x) is applied where its data exists: earnings from
Dec 2022, the pre-market table from Nov 2022, so 2022 runs without it. Per signal, on the bet's side (a put = mirror):
  r30 / r60 / close / next   the stock from the signal minute to +30 / +60 minutes, the close, the next day's close
  ex                          to the close minus beta x SPY's move
  s30                         to the close in S30 units (levels.ctx)
  mfe / mae                   the best / worst point to the close
  fail                        against the entry at both the 10- and 20-minute checks (the bot sells all then)
  big                         the best point to the next day's close >= 3 S30 (the kind of move a giant needs)

  node --env-file=.env <dir>/run.mjs sig22.py      (from the app repo root; after fetch22.py)
-> data/local/x/bt/sig22_signals.csv + printed tables
"""
import collections, csv, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ["BT_RULES"] = "c12_15"
import defence_signals as DS
import fav_real as FR
import news_filter as nf
from levels import ctx
from signals import beta
from store import P, calendar, day

B = "data/local/x/bt"
DS.SPAN = {"2022": ("2022-01-03", "2022-12-30"), "2023": ("2023-01-03", "2023-12-29"), "2024": ("2024-01-02", "2024-12-31"),
           "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-28")}
U = sorted((set(P["universe"]) | set(FR.FAV)) - {"SPY"})
HIS = set(P["universe"])
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}


def closes(bars):
    c = [None] * 390
    for b in bars:
        if 0 <= b[0] < 390: c[b[0]] = b[4]
    for m in range(1, 390):
        if c[m] is None: c[m] = c[m - 1]
    return c


def outcome(t):
    sym, d, m = t["sym"], t["date"], int(t["minute"]); bet = 1 if t["right"] == "C" else -1
    i = IDX.get(d)
    if i is None or i + 1 >= len(CAL): return None
    c, s = closes(day(sym, d)), closes(day("SPY", d))
    nb = day(sym, CAL[i + 1])
    if c[m] is None or s[m] is None: return None
    b_ = beta(sym, d, i, CAL); cx = ctx(sym, d)
    if b_ is None or not cx or not cx["sd"]: return None
    p = c[m]; mv = lambda x: bet * (x / p - 1)
    after = [x for x in c[m + 1:] if x]
    nxt = [b[4] for b in nb] if nb else []
    o = dict(r30=mv(c[min(389, m + 30)]), r60=mv(c[min(389, m + 60)]), close=mv(c[389]),
             ex=mv(c[389]) - b_ * bet * (s[389] / s[m] - 1), s30=mv(c[389]) / cx["sd"],
             mfe=max(map(mv, after), default=0.0), mae=min(map(mv, after), default=0.0),
             fail=int(mv(c[min(389, m + 10)]) < 0 and mv(c[min(389, m + 20)]) < 0),
             next=mv(nxt[-1]) if nxt else None,
             big=int(max([mv(x) for x in after + nxt], default=0.0) >= 3 * cx["sd"]))
    return o


def one(sym):
    rows = DS.stock(sym)["c12_15"]
    out = []
    for r in rows:
        o = outcome(r)
        if o: out.append({**r, **o})
    return out


def summary(R, label):
    if not R: return None
    q = lambda k: [r[k] for r in R if r[k] is not None]
    return dict(label=label, n=len(R), days=len({r["date"] for r in R}), calls=sum(r["right"] == "C" for r in R) / len(R),
                way=sum(r["close"] > 0 for r in R) / len(R), close=st.mean(q("close")), close_med=st.median(q("close")),
                ex=st.mean(q("ex")), s30=st.median(q("s30")), r30=st.mean(q("r30")), r60=st.mean(q("r60")),
                nxt=st.mean(q("next")) if q("next") else None, mfe=st.median(q("mfe")), mae=st.median(q("mae")),
                fail=sum(r["fail"] for r in R) / len(R), big=sum(r["big"] for r in R) / len(R))


def main():
    with mp.Pool(8) as pool: R = [r for part in pool.map(one, U) for r in part]
    nf.features(R)
    for r in R:
        r["news_ok"] = int(r["e_next"] != 0 and (r["pre_rvol"] is None or r["pre_rvol"] < 4))
        r["list"] = "his40" if r["sym"] in HIS else "fav"
    R.sort(key=lambda r: (r["date"], r["minute"], r["sym"]))
    cols = list(R[0])
    with open(f"{B}/sig22_signals.csv", "w") as f:
        w = csv.DictWriter(f, cols); w.writeheader(); w.writerows(R)
    print(len(R), "signals ->", f"{B}/sig22_signals.csv")
    # stock-days with bars per year (how much of each list the data covers)
    cover = collections.Counter()
    for sym in U:
        for d in CAL:
            if "2022" <= d[:4] <= "2026" and len(day(sym, d)) > 300: cover[d[:4]] += 1
    print("stock-days with bars:", dict(sorted(cover.items())))
    for title, F in (("All signals (no news filter, the same in every year)", lambda r: True),
                     ("With the news filter (2022: no data, so the same as above)", lambda r: r["news_ok"]),
                     ("His 40 only, news filter", lambda r: r["news_ok"] and r["list"] == "his40"),
                     ("Favorites only, news filter", lambda r: r["news_ok"] and r["sym"] in FR.FAV)):
        print(f"\n### {title}\n")
        print("| Year | Signals | Signal days | Per 100 stock-days | Calls | Closed our way | Mean to close | Median to close | vs SPY x beta | Median S30 | +30 min | +60 min | Next close | Best (median) | Worst (median) | Fail both checks | Big move (3 S30) |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for y in ("2022", "2023", "2024", "2025", "2026"):
            s = summary([r for r in R if r["date"][:4] == y and F(r)], y)
            if not s: continue
            print(f"| {y} | {s['n']} | {s['days']} | {100 * s['n'] / max(1, cover[y]):.1f} | {s['calls']:.0%} | {s['way']:.0%} | {s['close']:+.2%} | {s['close_med']:+.2%} | {s['ex']:+.2%} | "
                  f"{s['s30']:+.2f} | {s['r30']:+.2%} | {s['r60']:+.2%} | {s['nxt']:+.2%} | {s['mfe']:+.2%} | {s['mae']:+.2%} | {s['fail']:.0%} | {s['big']:.0%} |", flush=True)
    print("\n### 2022-2023 by quarter (all signals)\n")
    print("| Quarter | Signals | Calls | Closed our way | Mean to close | vs SPY x beta | Fail both checks | Big move |\n|---|---|---|---|---|---|---|---|")
    for y in ("2022", "2023"):
        for qn in range(4):
            S = [r for r in R if r["date"][:4] == y and (int(r["date"][5:7]) - 1) // 3 == qn]
            s = summary(S, "")
            if s: print(f"| {y} Q{qn + 1} | {s['n']} | {s['calls']:.0%} | {s['way']:.0%} | {s['close']:+.2%} | {s['ex']:+.2%} | {s['fail']:.0%} | {s['big']:.0%} |")


if __name__ == "__main__":
    main()
