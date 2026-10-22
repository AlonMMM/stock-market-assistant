"""V2: the big 0DTE run, summed up. Every strategy with the news filter, on the fair list and the 151 unseen stocks, 1% of
the current account from $100,000: the top by the fair list, the ones positive in every year on both lists, and each
factor's median result over all the others (which exit, entry, delta and fill timing win on the whole).

  python3 zero2_sum.py      (from the repo root, BT_UNIVERSE=wide; after zero2_round.py)
"""
import collections, csv, glob, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account
from zero2_round import ENTRIES, EXITS, DELTAS, FILLS

B = "data/local/x/bt"
NEWS = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
FAIR = lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]
UNSEEN = lambda t: t["sym"] not in HIS40


def main():
    rows = []
    feats = {}
    for e in ENTRIES:
        for x in EXITS:
            for d in DELTAS:
                for fill in FILLS:
                    p = f"z2_{e}_{x}_d{int(d * 100)}_{fill}"
                    T = sorted((t for f in glob.glob(f"{B}/{p}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
                               key=lambda t: (t["date"], int(t["minute"])))
                    if not T: continue
                    todo = [t for t in T if (t["date"], t["sym"], t["right"], t["minute"]) not in feats]
                    nf.features(todo)
                    for t in todo: feats[(t["date"], t["sym"], t["right"], t["minute"])] = (t["e_next"], t["pre_rvol"])
                    for t in T: t["e_next"], t["pre_rvol"] = feats[(t["date"], t["sym"], t["right"], t["minute"])]
                    F = [t for t in T if FAIR(t) and NEWS(t)]; U = [t for t in T if UNSEEN(t) and NEWS(t)]
                    if len(F) < 20: continue
                    yr = [[float(t["pnl"]) for t in F if t["date"][:4] == y] for y in ("2024", "2025", "2026")]
                    uy = [[float(t["pnl"]) for t in U if t["date"][:4] == y] for y in ("2024", "2025", "2026")]
                    a, dd = account(F); u, du = account(U)
                    rows.append(dict(e=e, x=x, d=d, fill=fill, n=len(F), yr=[st.fmean(v) if v else 0 for v in yr], uy=[st.fmean(v) if v else 0 for v in uy],
                                     win=sum(float(t["pnl"]) > 0 for t in F) / len(F), end=a, dd=dd, uend=u, udd=du, un=len(U)))
    line = lambda r: (f"| {r['e']} | {r['x']} | {r['d']:.2f} | {r['fill']} | {r['n']} | " + " / ".join(f"{v:+,.0f}" for v in r["yr"])
                      + f" | {100 * r['win']:.0f}% | ${r['end']:,.0f}, {100 * r['dd']:.0f}% | ${r['uend']:,.0f}, {100 * r['udd']:.0f}% |")
    head = "| Entry | Exit | Delta | Fill | Trades | Per trade 2024 / 2025 / 2026 | Win | Fair at 1% | Unseen at 1% |\n|---|---|---|---|---|---|---|---|---|"
    print(f"{len(rows)} strategies\n\n### Top 20 by the fair list\n\n{head}")
    for r in sorted(rows, key=lambda r: -r["end"])[:20]: print(line(r))
    good = [r for r in rows if all(v > 0 for v in r["yr"]) and all(v > 0 for v in r["uy"])]
    print(f"\n### Positive every year on both lists: {len(good)}\n\n{head}")
    for r in sorted(good, key=lambda r: -r["end"])[:20]: print(line(r))
    print("\n### Each factor: the median over all the other choices (fair end / unseen end)\n")
    for k, name in (("x", "Exit"), ("e", "Entry"), ("d", "Delta"), ("fill", "Fill")):
        g = collections.defaultdict(list)
        for r in rows: g[r[k]].append(r)
        print(f"| {name} | Strategies | Fair end, median | Unseen end, median | Positive both lists every year |\n|---|---|---|---|---|")
        for v, rs in sorted(g.items(), key=lambda kv: -st.median(r["end"] for r in kv[1])):
            print(f"| {v} | {len(rs)} | ${st.median(r['end'] for r in rs):,.0f} | ${st.median(r['uend'] for r in rs):,.0f} | {sum(r in good for r in rs)} |")
        print()


if __name__ == "__main__":
    main()
