"""Summary of a tiers_round.py round: every run per year, then the tier / leg split of the full version.

  python3 tiers_sum.py [t|w]
"""
import collections, csv, glob, os, statistics as st, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report

B = "data/local/x/bt"
TAG = (sys.argv[1:] or ["t"])[0]
YEARS = ("2024", "2025", "2026")
LABEL = [("flat", "Flat 1% on every C entry"), ("noroll", "Tiers + adds"), ("full", "Tiers + adds + roll 300%/60 min"),
         ("roll100_30", "… roll at +100% within 30 min"), ("roll200_60", "… roll at +200% within 60 min"), ("roll300_120", "… roll at +300% within 120 min"),
         ("roll100_30_run", "… roll +100%/30 min, rest runs (no +500% take)"), ("roll200_60_run", "… roll +200%/60 min, rest runs"),
         ("astart", "A only, A at the first minute, 3%"), ("astart_roll", "… + roll at +200%/60 min"), ("astart_roll_run", "… + roll +200%/60 min, rest runs"), ("atA", "A only, enter when A comes, 3%"),
         ("his", "His entries + same exits, $10K")]


def rows(name, y):
    p = f"{B}/{TAG}_{name}_{y}"
    if name == "his":
        T, S, _ = report.load(p)
        return [(1e4 * report.ret_at(S[t["_i"]], report.SH), 1e4) for t in T if t["status"] == "ok"], None
    T = [t for f in sorted(glob.glob(f"{p}.[0-9]_trades.csv")) for t in csv.DictReader(open(f))]
    ok = [t for t in T if t["status"] == "ok"]
    return [(float(t["pnl"]), float(t["premium"])) for t in ok], ok


print("| Version | Year | Trades | Per trade | Total | w/o best 5 | Win | Premium |\n|---|---|---|---|---|---|---|---|")
for name, lab in LABEL:
    for y in YEARS:
        R, _ = rows(name, y)
        if not R: continue
        P = sorted(r[0] for r in R)
        print(f"| {lab} | {y} | {len(P)} | {st.fmean(P):+,.0f} | {sum(P)/1e3:+,.0f}K | {sum(P[:-5])/1e3:+,.0f}K | {100*sum(p > 0 for p in P)/len(P):.0f}% | ${sum(r[1] for r in R)/1e6:,.1f}M |")
for name in ("full", "roll200_60", "roll100_30", "roll100_30_run", "roll200_60_run"):
    for y in YEARS:
        _, ok = rows(name, y)
        if not ok: continue
        legs = collections.defaultdict(list)
        for f in sorted(glob.glob(f"{B}/{TAG}_{name}_{y}.[0-9]_legs.csv")):
            for l in csv.DictReader(open(f)): legs[l["kind"]].append(float(l["premium"]) * float(l["ret"]))
        tops = {k: [float(t["pnl"]) for t in ok if t["top_tier"] == k] for k in "CBA"}
        print(f"{name} {y}: rolls {sum(t['rolled'] == '1' for t in ok)} | " + " | ".join(f"top {k}: {len(v)} trades {sum(v)/1e3:+,.0f}K" for k, v in tops.items() if v)
              + " || legs " + ", ".join(f"{k} {len(v)} {sum(v)/1e3:+,.0f}K" for k, v in sorted(legs.items())))
