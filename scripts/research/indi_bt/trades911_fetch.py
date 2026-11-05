"""Buy Databento OPRA trades (price, size, second) in a 9-minute window around every 2.10 sale (minute m-2 .. m+7),
for look 3 of the sale limit (the user, 2026-11-05: "approve the 9 minutes"; estimate ~$18). Overlapping windows of
the same contract-day are merged. One gz per day under indi_bt/dbx_cache/trades911/<day>.csv.gz; a done day is skipped.
  node --env-file=.env <dir>/run.mjs trades_fetch.py      (from the app repo root)"""
import collections, csv, gzip, os, sys
R = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, R)
from dbx_fetch import get, utc, save
OUT = os.path.join(R, "dbx_cache", "trades911")
HEAD = ["contract", "ts", "price", "size", "side"]
S = [r for r in csv.DictReader(open("data/local/x/bt/sale_limit_sales.csv")) if r["mode"] == "bid-c5"]
win = collections.defaultdict(list)
for r in S:
    m = int(r["minute"])
    win[(r["day"], r["contract"])].append((max(m - 2, 0), min(m + 7, 391)))
byday = collections.defaultdict(list)
for (d, c), ws in win.items():
    ws.sort(); merged = [list(ws[0])]
    for a, b in ws[1:]:
        if a <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], b)
        else: merged.append([a, b])
    for a, b in merged: byday[d].append((c, a, b))
days = sorted(byday)
print(f"{len(S):,} sales, {len(win):,} contract-days, {sum(len(v) for v in byday.values()):,} windows, {len(days)} days", flush=True)
from concurrent.futures import ThreadPoolExecutor


def fetch(d):
    path = os.path.join(OUT, f"{d}.csv.gz")
    if os.path.exists(path): return 0
    rows = []
    for c, a, b in byday[d]:
        for t in get([c], "trades", utc(d, a), utc(d, b)):
            rows.append([c, t.get("ts_event") or t.get("ts_recv"), t["price"], t["size"], t.get("side", "")])
    save(path, HEAD, rows)
    return len(rows)


with ThreadPoolExecutor(8) as ex:   # 8 days at a time (one day a minute alone)
    for i, n in enumerate(ex.map(fetch, days)):
        if i % 25 == 0: print(f"{i + 1}/{len(days)}: {n} trades", flush=True)
print("done", flush=True)
