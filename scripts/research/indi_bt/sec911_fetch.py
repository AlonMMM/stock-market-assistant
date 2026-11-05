"""Buy second-level option books around every 2.10 sale, minute m-1 .. m+1 (the user, 2026-11-05: "go" on the 16-second
ladder; estimate ~$0.55): cbbo-1s from 2025-02-20, cmbp-1 (every book change) before. One gz per day under
indi_bt/dbx_cache/sec911/<day>.csv.gz: contract, second of the session (the book AT that second: cbbo-1s rows are
stamped at their interval's end, so -1 s, as exit10.py), bid, ask. A done day is skipped.
  node --env-file=.env <dir>/run.mjs sec911_fetch.py      (from the app repo root)"""
import collections, csv, gzip, io, os, re, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo
R = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, R)
import leg_seconds as LS
from dbx_fetch import save
OUT = os.path.join(R, "dbx_cache", "sec911")
NY = ZoneInfo("America/New_York")


def sec(ts):
    x = ts.replace("Z", "")
    if "." in x: a, b = x.split("."); x = f"{a}.{b[:6]}"
    t = datetime.fromisoformat(x).replace(tzinfo=ZoneInfo("UTC")).astimezone(NY)
    return t.hour * 3600 + t.minute * 60 + t.second + t.microsecond / 1e6 - 34200


S = [r for r in csv.DictReader(open("data/local/x/bt/sale_limit_sales.csv")) if r["mode"] == "bid-c5"]
win = collections.defaultdict(list)
for r in S:
    m = int(r["minute"])
    win[(r["day"], r["contract"])].append((max(m - 1, 0), min(m + 2, 391)))
byday = collections.defaultdict(list)
for (d, c), ws in win.items():
    ws.sort(); mg = [list(ws[0])]
    for a, b in ws[1:]:
        if a <= mg[-1][1]: mg[-1][1] = max(mg[-1][1], b)
        else: mg.append([a, b])
    for a, b in mg: byday[d].append((c, a, b))
days = sorted(byday)
print(f"{len(S):,} sales, {sum(len(v) for v in byday.values()):,} windows, {len(days)} days", flush=True)


def fetch(d):
    path = os.path.join(OUT, f"{d}.csv.gz")
    if os.path.exists(path): return 0
    one_s = d >= LS.SEC1
    rows = []
    for c, a, b in byday[d]:
        m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", c)
        text = LS.get("OPRA.PILLAR", "cbbo-1s" if one_s else "cmbp-1", m.group(1).ljust(6) + m.group(2), d, a * 60, b * 60)
        for x in csv.DictReader(io.StringIO(text)):
            if x.get("bid_px_00") and x.get("ask_px_00"):
                rows.append([c, round(sec(x["ts_recv"]) - (1 if one_s else 0), 3), x["bid_px_00"], x["ask_px_00"]])
    save(path, ["contract", "sec", "bid", "ask"], rows)
    return len(rows)


with ThreadPoolExecutor(16) as ex:
    for i, n in enumerate(ex.map(fetch, days)):
        if i % 50 == 0: print(f"{i + 1}/{len(days)}: {n} book rows", flush=True)
print("done", flush=True)
