"""Minute quotes (cbbo-1m) for leg_seconds.py picks that dbx_cache lacks (the fast alert's contracts, 2026-10-27):
every pick of events<TAG>.json / picks<TAG>.json not in dbx_cache/<date>.csv.gz -> dbx_cache/extra/<date>.csv.gz,
from the pick's minute to 15:31. leg_realspread.quotes() reads both.
  SEC_TAG=fast12 node --env-file=.env <dir>/run.mjs extra_quotes.py
"""
import csv, gzip, json, os, sys
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dbx_fetch as F

TAG = os.environ.get("SEC_TAG", "")
WAIT = int(os.environ.get("SEC_WAIT", "10"))
WTAG = "" if WAIT == 10 else f"_w{WAIT}"
K = float(os.environ.get("SEC_K", "0.25"))
KTAG = "" if K == 0.25 else f"_k{K}"
OUT = os.path.join(HERE, "dbx_cache", "extra")


def fetch(item):
    date, cs = item
    path = os.path.join(OUT, f"{date}.csv.gz")
    old = {}
    if os.path.exists(path):
        for r in csv.DictReader(gzip.open(path, "rt")): old.setdefault(r["contract"], []).append(r)
    want = {c: m for c, m in cs.items() if c not in old}
    if not want: return
    rows = [[r[k] for k in F.HEAD] for v in old.values() for r in v]
    end = max(F.END, min(392, max(want.values()) + 12))   # a late alert (after 15:31) reaches past the usual end
    for r in F.get(sorted(want), "cbbo-1m", F.utc(date, min(want.values())), F.utc(date, end)):
        if not r["bid_px_00"] or not r["ask_px_00"]: continue
        t = F.datetime.fromisoformat(r["ts_recv"].replace("Z", "+00:00")).astimezone(F.NY)
        rows.append([r["symbol"].replace(" ", ""), t.hour * 60 + t.minute - 570, r["bid_px_00"], r["ask_px_00"], r["bid_sz_00"], r["ask_sz_00"]])
    F.save(path, F.HEAD, rows)


if __name__ == "__main__":
    ev = json.load(open(os.path.join(HERE, "sec_cache", f"events{TAG}.json")))
    pk = json.load(open(os.path.join(HERE, "sec_cache", f"picks{TAG}{WTAG}{KTAG}.json")))
    need = {}
    # EXQ_HAVE_OPT=1: only the contracts whose per-second book was fetched (the trades that pass the filters)
    have_opt = {tuple(f.split("_")[:2]) for f in os.listdir(os.path.join(HERE, "sec_cache", "opt"))} if os.environ.get("EXQ_HAVE_OPT") else None
    for i, e in enumerate(ev):
        for k, x in pk[i]["p"].items():
            if have_opt is not None and (e["date"], x[0]) not in have_opt: continue
            m = max(0, e["m"] - 1)
            cur = need.setdefault(e["date"], {})
            cur[x[0]] = min(m, cur.get(x[0], 999))
    have = {}
    for d in need:
        p = os.path.join(HERE, "dbx_cache", f"{d}.csv.gz")
        have[d] = {r["contract"] for r in csv.DictReader(gzip.open(p, "rt"))} if os.path.exists(p) else set()
    todo = {d: {c: m for c, m in cs.items() if c not in have[d]} for d, cs in need.items()}
    todo = {d: cs for d, cs in todo.items() if cs}
    print(sum(len(v) for v in todo.values()), "contract-days on", len(todo), "days", flush=True)
    os.makedirs(OUT, exist_ok=True)
    with ThreadPoolExecutor(10) as ex: list(ex.map(fetch, sorted(todo.items())))
    print("done")
