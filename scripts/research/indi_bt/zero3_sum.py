"""V2: 0DTE in Indi's delta range, summed up. Each strategy with the news filter, with and without the SPY filter (no
entry while SPY is more than 0.5% from yesterday's close, either way), on the fair list and the 151 unseen stocks, 1% of
the current account from $100,000: the top, the ones positive every year on both lists, each factor's median, and
the Friday split (single-stock 0DTE exists almost only on Fridays before 2026).

  python3 zero3_sum.py      (from the repo root, BT_UNIVERSE=wide; after zero3_round.py)
"""
import collections, csv, datetime as dt, glob, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import news_filter as nf
from store import day, calendar
from signals import series
from low_delta import HIS40, PRIOR
from score_sum import account
from zero3_round import ENTRIES, WINS, EXITS, DELTAS, FILLS

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
NEWS = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
FAIR = lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]
UNSEEN = lambda t: t["sym"] not in HIS40
_spy = {}


def spy_move(date, m):
    if date not in _spy:
        _spy[date] = (series(day("SPY", date))[0], day("SPY", CAL[IDX[date] - 1])[-1][4])
    c, pc = _spy[date]
    return (c[m] / pc - 1) * 100 if c[m] else 0.0


def main():
    rows, feats = [], {}
    for e in ENTRIES:
        for w in WINS:
            for x in EXITS:
                for d in DELTAS:
                    for fill in FILLS:
                        p = f"z3_{e}_{w}_{x}_d{int(d * 100)}_{fill}"
                        T = sorted((t for f in glob.glob(f"{B}/{p}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
                                   key=lambda t: (t["date"], int(t["minute"])))
                        if not T: continue
                        todo = [t for t in T if (t["date"], t["sym"], t["right"], t["minute"]) not in feats]
                        nf.features(todo)
                        for t in todo: feats[(t["date"], t["sym"], t["right"], t["minute"])] = (t["e_next"], t["pre_rvol"], spy_move(t["date"], int(t["minute"])))
                        for t in T: t["e_next"], t["pre_rvol"], t["spy"] = feats[(t["date"], t["sym"], t["right"], t["minute"])]
                        for spyf in (False, True):
                            ok = lambda t: NEWS(t) and (not spyf or abs(t["spy"]) <= 0.5)
                            F = [t for t in T if FAIR(t) and ok(t)]; U = [t for t in T if UNSEEN(t) and ok(t)]
                            if len(F) < 15: continue
                            yr = [[float(t["pnl"]) for t in F if t["date"][:4] == y] for y in ("2024", "2025", "2026")]
                            uy = [[float(t["pnl"]) for t in U if t["date"][:4] == y] for y in ("2024", "2025", "2026")]
                            a, dd = account(F); u, du = account(U)
                            fri = [float(t["pnl"]) for t in F if dt.date.fromisoformat(t["date"]).weekday() == 4]
                            rows.append(dict(e=e, w=w, x=x, d=d, fill=fill, spy="yes" if spyf else "no", n=len(F),
                                             yr=[st.fmean(v) if v else 0 for v in yr], uy=[st.fmean(v) if v else 0 for v in uy],
                                             win=sum(float(t["pnl"]) > 0 for t in F) / len(F), end=a, dd=dd, uend=u, udd=du,
                                             fri=(len(fri), sum(fri)), other=(len(F) - len(fri), sum(float(t["pnl"]) for t in F) - sum(fri))))
    line = lambda r: (f"| {r['e']} | {r['w']} | {r['x']} | {r['d']:.2f} | {r['fill']} | {r['spy']} | {r['n']} | " + " / ".join(f"{v:+,.0f}" for v in r["yr"])
                      + f" | {100 * r['win']:.0f}% | ${r['end']:,.0f}, {100 * r['dd']:.0f}% | ${r['uend']:,.0f}, {100 * r['udd']:.0f}% |")
    head = ("| Entry | Window | Exit | Delta | Fill | SPY filter | Trades | Per trade 2024 / 2025 / 2026 | Win | Fair at 1% | Unseen at 1% |\n"
            "|---|---|---|---|---|---|---|---|---|---|---|")
    print(f"{len(rows)} strategies (each with and without the SPY filter)\n\n### Top 20 by the fair list\n\n{head}")
    for r in sorted(rows, key=lambda r: -r["end"])[:20]: print(line(r))
    good = [r for r in rows if all(v > 0 for v in r["yr"]) and all(v > 0 for v in r["uy"])]
    print(f"\n### Positive every year on both lists: {len(good)}\n\n{head}")
    for r in sorted(good, key=lambda r: -r["end"])[:25]: print(line(r))
    print("\n### Each factor: the median over all the other choices\n")
    for k, name in (("spy", "SPY filter"), ("w", "Window"), ("x", "Exit"), ("e", "Entry"), ("d", "Delta"), ("fill", "Fill")):
        g = collections.defaultdict(list)
        for r in rows: g[r[k]].append(r)
        print(f"| {name} | Strategies | Fair end, median | Unseen end, median | Positive both lists every year |\n|---|---|---|---|---|")
        for v, rs in sorted(g.items(), key=lambda kv: -st.median(r["end"] for r in kv[1])):
            print(f"| {v} | {len(rs)} | ${st.median(r['end'] for r in rs):,.0f} | ${st.median(r['uend'] for r in rs):,.0f} | {sum(1 for r in rs if r in good)} |")
        print()
    fr = [r["fri"] for r in rows]; ot = [r["other"] for r in rows]
    print(f"Friday trades: {sum(n for n, _ in fr)} in all strategies, total ${sum(p for _, p in fr) / 1e3:,.0f}K; Mon / Wed: {sum(n for n, _ in ot)}, ${sum(p for _, p in ot) / 1e3:,.0f}K (at $10K a trade)")


if __name__ == "__main__":
    main()
