"""Signal-day filters, combined: pick on tune (mean move our way, n >= 300), then the pick on check. Stock only."""
import csv, glob, gzip, collections, datetime as dt, statistics as st, math, itertools, sys
sig = {}
for fn in sorted(glob.glob("data/local/x/bt/sg_c12_15_20*_trades.csv")):
    for r in csv.DictReader(open(fn)): sig[(r["sym"], r["date"], r["right"])] = r
F = {}
with gzip.open("data/local/x/bt/nightly_feat.csv.gz", "rt") as fh:
    for r in csv.DictReader(fh):
        if r["earn"] == "1" or dt.date.fromisoformat(r["date"]).weekday() == 4 or r["z_on"] == "": continue
        F[(r["sym"], r["date"], r["side"])] = r
f = float
rows = [(F[k], s) for k, s in sig.items() if k in F]
COST = 0.0004
FILT = {
  "any": lambda r, s: True,
  "pullback": lambda r, s: f(r["lh_run"]) < -0.3,
  "late_sig": lambda r, s: int(s["minute"]) >= 60,
  "vol2.5": lambda r, s: f(r["rvol"]) >= math.log(2.5),
  "vol1.5": lambda r, s: f(r["rvol"]) >= math.log(1.5),
  "t2": lambda r, s: f(r["t"]) >= 2,
  "burst11": lambda r, s: f(r["burst_n"]) >= 11,
  "pos.7": lambda r, s: f(r["pos"]) >= 0.7,
}
def stats(R):
    on = [f(r["on"]) - COST for r, _ in R]; z = [f(r["z_on"]) for r, _ in R]
    nights = len({r["date"] for r, _ in R})
    return dict(n=len(R), nights=nights, mean=st.fmean(on), med=st.median(on), up=sum(x > 0 for x in on) / len(on),
                z2=sum(x >= 2 for x in z) / len(z), zm1=sum(x <= -1 for x in z) / len(z),
                se=st.pstdev(on) / math.sqrt(len(on)))
res = []
names = [k for k in FILT if k != "any"]
combos = [("any",)] + [(a,) for a in names] + list(itertools.combinations(names, 2)) + list(itertools.combinations(names, 3))
for c in combos:
    R = [x for x in rows if x[0]["half"] == "tune" and all(FILT[k](*x) for k in c)]
    if len(R) >= 300: res.append((stats(R)["mean"], c, stats(R)))
res.sort(key=lambda q: -q[0])
print(f"{len(combos)} combinations scanned, {len(res)} with n >= 300 on tune\n\n| filter | n (tune) | bets / year | mean after 0.04% | median | up | z >= 2 | z <= -1 | mean / se |\n|---|---|---|---|---|---|---|---|---|")
for m, c, s in res[:12] + [x for x in res if x[1] == ("any",)]:
    print(f"| {' + '.join(c)} | {s['n']:,} | {s['n'] / 1.33:.0f} | {s['mean']*100:+.3f}% | {s['med']*100:+.3f}% | {s['up']:.0%} | {s['z2']:.1%} | {s['zm1']:.1%} | {s['mean']/s['se']:.1f} |")
pick = res[0][1]
print(f"\nPicked on tune: {' + '.join(pick)} 🎯\n\n| half | filter | n | mean after 0.04% | median | up | z >= 2 | z <= -1 | mean / se |\n|---|---|---|---|---|---|---|---|---|")
for h in ("tune", "check"):
    for c in (pick, ("any",)):
        R = [x for x in rows if x[0]["half"] == h and all(FILT[k](*x) for k in c)]
        s = stats(R)
        print(f"| {h} | {' + '.join(c)} | {s['n']:,} | {s['mean']*100:+.3f}% | {s['med']*100:+.3f}% | {s['up']:.0%} | {s['z2']:.1%} | {s['zm1']:.1%} | {s['mean']/s['se']:.1f} |")
