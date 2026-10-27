"""The live bot's exit for leg_seconds.py trades: every 10 s on the stock's last trade (EQUS.MINI ohlcv-1s), the best
since the buy and the give-back line from those ticks, sold at the option's bid 2 s after the tick that crossed
(cbbo-1s; cmbp-1 before 2025-02-20). The backtest's walk checked minute closes only, so it sold late (TSLA 2025-09-12:
the line was crossed at 9:58:22 with the bid near $1.15, the walk sold at 9:59:00 at $0.69).
A 10-second exit is never later than the minute-close one, so the stock is fetched from the buy to the walk's exit.
  SEC_TAG=3y50 STR_TOP=50 node --env-file=.env <dir>/run.mjs exit10.py stock|option|build
-> sec_cache/exit10_<TAG>.json {"date|sym|minute": [exit second, bid, ask]}   (leg_seconds.py STR_EXIT=sec10 reads it)"""
import csv, gzip, io, json, os, re, sys, threading
from concurrent.futures import ThreadPoolExecutor
os.environ.setdefault("BT_VARIANT", "v2")
import leg_seconds as LS
import leg_fallback as LF
from store import day

OUT = os.path.join(LS.OUT, "exit10"); os.makedirs(OUT, exist_ok=True)
TICK, SELL_LAG = 10, 2
# EXIT10_MODE: live = best and check on every 10-second tick (the live bot); minbest = the best from minute closes, the
# check every 10 s; early5 = the live check for the first 5 minutes after the buy, then nothing (the walk's minute exit)
MODE = os.environ.get("EXIT10_MODE", "live")
MTAG = "" if MODE == "live" else f"_{MODE}"
ev = json.load(open(os.path.join(LS.OUT, f"events{LS.TAG}.json")))
pk = json.load(open(os.path.join(LS.OUT, f"picks{LS.TAG}{LS.WTAG}{LS.KTAG}.json")))
top = set(json.load(open(os.path.join(LS.HERE, "strangle_rank.json")))[:int(os.environ.get("STR_TOP", "999"))])
JOBS = [(ev[i], pk[i]["p"]["cross|plain20"][0], pk[i]["t"]["cross"]) for i in range(len(ev))
        if "cross|plain20" in pk[i]["p"] and ev[i]["sym"] in top]


def key(e): return f"{e['date']}|{e['sym']}|{e['m']}"
def spath(e): return os.path.join(OUT, "stock", f"{e['date']}_{e['sym']}_{e['m']}.csv.gz")
def opath(e, contract, s): return os.path.join(OUT, "opt", f"{e['date']}_{contract}_{s}.csv.gz")


def walk(job):
    e, contract, (sec, side, spot) = job
    return LF.walk(e["sym"], e["date"], sec // 60, side, contract, spot, e["u"])


def save(p, rows):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.{threading.get_ident()}.tmp"   # two jobs can share a file
    with gzip.open(tmp, "wt") as f: csv.writer(f).writerows(rows)
    os.replace(tmp, p)


def fetch_stock(item):
    job, w = item
    e, contract, (sec, side, spot) = job
    p = spath(e)
    if os.path.exists(p) or not w: return
    text = LS.get("EQUS.MINI", "ohlcv-1s", e["sym"], e["date"], sec, (w[3] + 1) * 60 + 1)
    save(p, [(LS.sec_of(r["ts_event"]), r["close"]) for r in csv.DictReader(io.StringIO(text))])


def exit_sec(job):
    """The first 10-second tick after the buy where the stock is past the give-back line, or None (the walk's exit stands)."""
    e, contract, (sec, side, spot) = job
    p = spath(e)
    if not os.path.exists(p): return None
    secs = [(int(a), float(b)) for a, b in csv.reader(gzip.open(p, "rt"))]
    best, last, k = spot, None, 0
    t = (sec + LS.LAG) // TICK * TICK + TICK
    end = secs[-1][0] if secs else sec
    if MODE == "early5": end = min(end, sec + 300)
    while t <= end:
        while k < len(secs) and secs[k][0] <= t: last = secs[k][1]; k += 1
        if last:
            mark = last
            if MODE == "minbest" and t % 60: mark = None   # the best moves on minute closes only
            if mark: best = max(best, mark) if side == "C" else min(best, mark)
            if (side == "C" and last < best * (1 - LF.GIVE * e["u"])) or (side == "P" and last > best * (1 + LF.GIVE * e["u"])): return t
        t += TICK
    return None


def fetch_opt(job):
    e, contract, tg = job
    t = exit_sec(job)
    if t is None: return
    p = opath(e, contract, t)
    if os.path.exists(p): return
    m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", contract)
    schema, back, shift = ("cbbo-1s", 2, 1) if e["date"] >= LS.SEC1 else ("cmbp-1", 30, 0)
    text = LS.get("OPRA.PILLAR", schema, m.group(1).ljust(6) + m.group(2), e["date"], t - back, t + SELL_LAG + 10)
    save(p, [(LS.sec_of(r["ts_recv"]) - shift, r["bid_px_00"], r["ask_px_00"]) for r in csv.DictReader(io.StringIO(text))
             if r["bid_px_00"] and r["ask_px_00"]])


def build():
    out, n, moved = {}, 0, 0
    for job in JOBS:
        e, contract, tg = job
        t = exit_sec(job)
        if t is None: continue
        p = opath(e, contract, t)
        if not os.path.exists(p): continue
        rows = [(int(a), b, c) for a, b, c in csv.reader(gzip.open(p, "rt")) if float(b) > 0 and float(c) > 0]
        q = LS.book_at(rows, t + SELL_LAG)
        if not q: continue
        out[key(e)] = [t, q[0], q[1]]; n += 1
    json.dump(out, open(os.path.join(LS.OUT, f"exit10_{LS.TAG}{MTAG}.json"), "w"))
    print(len(JOBS), "jobs,", n, "with a 10-second exit")


if __name__ == "__main__":
    step = sys.argv[1]
    if step == "build": build(); sys.exit()
    items = JOBS
    fn = fetch_opt
    if step == "stock":   # the walks read the bar database, so they run here, not in the download threads
        items, fn = [(j, walk(j)) for j in JOBS], fetch_stock
    with ThreadPoolExecutor(30) as ex:
        for n, _ in enumerate(ex.map(fn, items)):
            if n % 500 == 0: print(n, "/", len(JOBS), flush=True)
    print("done")
