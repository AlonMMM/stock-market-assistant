"""Do the main bot's day signals (rule c12_15, bought or not) predict the next morning? Tune weeks only.
Joins each signal-day (sym, date, side) to nightly_feat.csv.gz (15:57 measures + the 15:57 -> 09:45 move)."""
import csv, glob, gzip, collections, datetime as dt, statistics as st, sys
sys.path.insert(0, '/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt')
from split import half
sig = collections.defaultdict(list)
for f in sorted(glob.glob("data/local/x/bt/sg_c12_15_20*_trades.csv")):
    for r in csv.DictReader(open(f)): sig[(r["sym"], r["date"], r["right"])].append(r)
F = {}
with gzip.open("data/local/x/bt/nightly_feat.csv.gz", "rt") as fh:
    for r in csv.DictReader(fh):
        if r["earn"] == "1" or dt.date.fromisoformat(r["date"]).weekday() == 4 or r["z_on"] == "": continue
        F[(r["sym"], r["date"], r["side"])] = r
f = float
syms = {k[0] for k in sig}
base = [r for k, r in F.items() if k[0] in syms and r["half"] == "tune"]
hits = [(F[k], v) for k, v in sig.items() if k in F and F[k]["half"] == "tune"]
print(f"signal-days {len(sig):,}; with 15:57 data (no earnings / Friday) tune {len(hits):,} on {len({r['date'] for r, _ in hits})} nights; signal stocks {len(syms)}")
def line(name, R):
    if len(R) < 30: return
    on = [f(r["on"]) for r in R]; z = [f(r["z_on"]) for r in R]
    print(f"| {name} | {len(R):,} | {st.fmean(on)*100:+.3f}% | {st.median(on)*100:+.3f}% | {sum(x > 0 for x in on)/len(on):.0%} | {sum(x >= 1 for x in z)/len(z):.1%} | {sum(x >= 2 for x in z)/len(z):.1%} | {sum(x <= -1 for x in z)/len(z):.1%} |")
print("\n| group | n | mean move our way | median | up | z >= 1 | z >= 2 | z <= -1 (against) |\n|---|---|---|---|---|---|---|---|")
line("every stock-side of the same stocks (baseline)", base)
line("every signal-day", [r for r, _ in hits])
first = lambda v: min(int(x["minute"]) for x in v)
for a, b, nm in ((0, 60, "first signal 09:30-10:29"), (60, 180, "10:30-12:29"), (180, 300, "12:30-14:29"), (300, 390, "14:30-16:00")):
    line(nm, [r for r, v in hits if a <= first(v) < b])
for nm, cond in (("1 signal that day", lambda v: len(v) == 1), ("2-3 signals", lambda v: 2 <= len(v) <= 3), ("4+ signals", lambda v: len(v) >= 4)):
    line(nm, [r for r, v in hits if cond(v)])
line("bought (ok)", [r for r, v in hits if any(x["status"] == "ok" for x in v)])
line("never bought", [r for r, v in hits if not any(x["status"] == "ok" for x in v)])
def held(r, v):   # the stock at 15:57 vs the first signal's price, its side
    p0 = f(min(v, key=lambda x: int(x["minute"]))["price"]); bet = 1 if v[0]["right"] == "C" else -1
    return bet * (1 + f(r["on"]) * 0) and None
for nm, lo, hi in (("range pos >= 0.9 at 15:57", 0.9, 9), ("pos 0.7-0.9", 0.7, 0.9), ("pos < 0.7 (gave back)", -9, 0.7)):
    line(nm, [r for r, v in hits if lo <= f(r["pos"]) < hi])
for nm, lo, hi in (("last hour pulled back (lh_run < -0.3)", -99, -0.3), ("last hour flat (-0.3..0.5)", -0.3, 0.5), ("last hour ran (>= 0.5)", 0.5, 99)):
    line(nm, [r for r, v in hits if lo <= f(r["lh_run"]) < hi])
import math
for nm, lo, hi in (("day volume < 1.5x", -9, math.log(1.5)), ("1.5-2.5x", math.log(1.5), math.log(2.5)), ("2.5x+", math.log(2.5), 99)):
    line(nm, [r for r, v in hits if lo <= f(r["rvol"]) < hi])
for nm, lo, hi in (("t at 15:57 < 1.2", -99, 1.2), ("t 1.2-2", 1.2, 2), ("t 2+", 2, 99)):
    line(nm, [r for r, v in hits if lo <= f(r["t"]) < hi])
for nm, lo, hi in (("bursts < 6", -1, 6), ("bursts 6-10", 6, 11), ("bursts 11+", 11, 999)):
    line(nm, [r for r, v in hits if lo <= f(r["burst_n"]) < hi])
