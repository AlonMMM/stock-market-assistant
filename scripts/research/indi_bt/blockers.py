"""What stops each filtered trade from being taken (the account's rules, replayed per trade) and the news-day split.
  BL_IN=<STR_DUMP_ALL file> BL_CROSS=15 BL_AM=0 python3 blockers.py > out.json"""
import json, os, sys
os.environ.setdefault("BT_VARIANT", "v2")
import news_filter as nf
A = json.load(open(os.environ["BL_IN"]))
for r in A: r["ret"] = (r["sell"] * 100 - 0.62) / (r["buy"] * 100 + 0.62) - 1
rows = [dict(date=r["date"], sym=r["sym"], minute=0, right=r["side"]) for r in A]
nf.features(rows)
for r, f in zip(A, rows): r.update(e_next=f["e_next"], e_last=f["e_last"], pre_rvol=f["pre_rvol"], pre_gap=f["pre_gap"])
C, AM = int(os.environ.get("BL_CROSS", "15")), float(os.environ.get("BL_AM", "0"))
OPEN, PER = int(os.environ.get("BL_OPEN", "5")), int(os.environ.get("BL_PER", "2"))
cand = [r for r in A if not r["news_skip"] and r["to_cross"] <= C and r["am"] is not None and r["am"] >= AM]
for r in cand: r["why"] = None
by = {}
for r in cand: by.setdefault((r["date"], r["sym"]), []).append(r)
kept = []
for k, evs in by.items():   # leg_twice.pick "flat": one position a stock at a time, then the first PER
    busy, n = -1, 0
    for r in sorted(evs, key=lambda z: z["minute"]):
        if r["ct"] <= busy: r["why"] = "same stock still open"; continue
        if n >= PER: r["why"] = f"{PER} trades on the stock already"; continue
        n += 1; busy = r["xm"]; kept.append(r)
eq, by_day = 1e5, {}
for r in kept: by_day.setdefault(r["date"], []).append(r)
for d in sorted(by_day):   # leg_daycap.account: day loss 7.5%, 15 trades, OPEN open
    start, done = eq, []
    for r in sorted(by_day[d], key=lambda t: (t["bm"], t["minute"])):
        closed = sum(p for x, p, b in done if x < r["bm"])
        if closed <= -0.075 * start: r["why"] = "day loss limit"; continue
        if len(done) >= 15: r["why"] = "15 trades a day"; continue
        if sum(1 for x, p, b in done if x >= r["bm"]) >= OPEN: r["why"] = f"{OPEN} positions open"; continue
        q = int(0.01 * start // (r["buy"] * 100))
        if q < 1: r["why"] = "too pricey for 1% of the account"; continue
        pnl = q * (r["sell"] - r["buy"]) * 100 - 1.24 * q
        done.append((r["xm"], pnl, r["bm"])); r["why"] = "traded"
    eq += sum(p for x, p, b in done)
json.dump(dict(cand=cand, all=A), sys.stdout, default=str)
