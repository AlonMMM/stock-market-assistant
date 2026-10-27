"""Which Databento minute label matches the option trade bar of minute j: label j-1, j, j+1?"""
import sys, os, csv, gzip, glob, random
sys.path.insert(0, "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
os.environ.setdefault("BT_VARIANT", "v2")
from store import day
D = "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt/dbx_cache/indi"
files = sorted(glob.glob(D + "/20*.csv.gz")); random.seed(1)
hit = {-1: [0, 0], 0: [0, 0], 1: [0, 0]}; dist = {-1: 0.0, 0: 0.0, 1: 0.0}; n = 0
for f in random.sample(files, 40):
    date = os.path.basename(f)[:10]; by = {}
    for r in csv.DictReader(gzip.open(f, "rt")):
        if r["bid"] and r["ask"] and float(r["bid"]) > 0: by.setdefault(r["contract"], {})[int(r["minute"])] = (float(r["bid"]), float(r["ask"]))
    for c, q in list(by.items())[:60]:
        for b in day(c, date):
            j, close = b[0], b[4]
            if not all(j + k in q for k in (-1, 0, 1)): continue
            n += 1
            for k in (-1, 0, 1):
                bid, ask = q[j + k]
                hit[k][0] += bid - 1e-9 <= close <= ask + 1e-9
                dist[k] += abs(close - (bid + ask) / 2) / ((bid + ask) / 2)
print("bars", n)
for k in (-1, 0, 1): print(f"label j{k:+d}: close inside the book {hit[k][0] / n:.1%}, mean |close - mid| {dist[k] / n:.2%}")
