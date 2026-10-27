"""The Main bot's benchmark on real quotes (the user, 2026-10-26: "we have now real bid and ask from databento. I would
like to run our main bot tests with this real data to confirm. show me in artifact all the results").

Every version on the Bot vs Indi benchmark (export_bench.VERSIONS: 2.4, 2.5, 2.6 = 2.5 + cheap, the fallbacks, the
failed-break sale), the fair list, the same entries, contracts and exits (sim.walk on trade bars). Each trade priced
twice:
  old   the test as it was: the next 1-minute trade bar's mid, +2% on a buy, -2% on a sale
  real  the best bid/ask (Databento OPRA cbbo-1m, dbx_fetch.py indi -> dbx_cache/indi/) at the end of the minute before
        the fill minute, as indi_real.py: a buy pays the mid + half the way to the ask, or the next minute's ask (at
        most +10%) when the bid already ran past that; a sale gets the bid. No quote within 5 minutes: the old price
        (counted as "no quote").
$0.62 a contract each way and the 10% overnight cap at each size (sim.result). Feb 2024 - 16 Oct 2026 (the last quote
day) for both, so old and real cover the same trades. Per trade also: the half-spread at the entry, open interest
(OPRA statistics) and the entry price, for the cuts on the page.

  node --env-file=.env <dir>/run.mjs real_bench.py      (from the app repo root)
-> data/local/x/bt/real_bench_trades.csv, real_bench_summary.json
"""
import bisect, csv, glob, gzip, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = eb.CAL
LAST = "2026-10-16"
DBX = os.path.join(HERE, "dbx_cache", "indi")
Q, OI = {}, {}


def book(date):
    if date not in Q:
        if len(Q) > 3: Q.clear()
        by = {}
        path = os.path.join(DBX, f"{date}.csv.gz")
        if os.path.exists(path):
            for r in csv.DictReader(gzip.open(path, "rt")):
                if r["bid"] and r["ask"] and float(r["ask"]) > 0 and float(r["bid"]) > 0:
                    by.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
        for v in by.values(): v.sort()
        Q[date] = by
    return Q[date]


def oi(date, c):
    if date not in OI:
        if len(OI) > 3: OI.clear()
        path = os.path.join(DBX, "oi", f"{date}.csv.gz")
        OI[date] = {r["contract"]: int(r["oi"]) for r in csv.DictReader(gzip.open(path, "rt"))} if os.path.exists(path) else {}
    return OI[date].get(c)


def quote(c, date, minute):
    """The book at the end of `minute`, at most 5 minutes old. A cache row's minute is the book as that minute BEGAN
    (dbx_fetch.py: cbbo-1m's ts_recv is the interval's end), so the end of `minute` is the row labelled minute + 1.
    Fixed 2026-10-27 (entry audit): this read the row labelled `minute`, a book one minute too early, so every fill was
    priced on the quote from before the bar that triggered it (option trade bars: the bar's last print sits inside the
    row labelled j + 1 86% of the time, j 65%, j - 1 52%; label_test in the log)."""
    v = book(date).get(c)
    if not v: return None
    i = bisect.bisect(v, (minute + 2, 1e9, 1e9)) - 1
    if i < 0 or v[i][0] < minute - 3: return None
    return v[i][1], v[i][2]


def one(job):
    slug, t = job
    _, _, exits, fb = eb.VERSIONS[slug]
    p = eb.contract(t, fb)
    if not p: return None
    sim.X.clear(); sim.X.update(exits)
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], p[0], p[1], CAL)
    if cost is None: return None
    real, miss, rcost, spread, entry_mid = [], 0, cost, None, None
    for d, m, side, q, px, rule in steps:
        if side not in ("buy", "sell"): real.append((d, m, side, q, px, rule)); continue
        at = max(m - 1, 0)
        k = quote(p[0], d, at)
        if not k: miss += 1; real.append((d, m, side, q, px, rule)); continue
        bid, ask = k; mid = (bid + ask) / 2
        if side == "buy":
            price = mid + (ask - mid) / 2
            later = quote(p[0], d, at + 1)
            if later and later[0] > price: price = min(later[1], price * 1.1)
            if rule != "rebuy":
                rcost = price; spread = (ask - bid) / 2 / mid; entry_mid = mid
        else:
            price = bid
        real.append((d, m, side, q, round(price, 4), rule))
    last_sell = [s for s in steps if s[2] == "sell"]
    return dict(version=slug, date=t["date"], sym=t["sym"], right=t["right"], minute=int(t["minute"]), contract=p[0],
                fallback="" if t["status"] == "ok" else t["status"], d2=int(float(t.get("c_t") or 9) < 1.8),
                old_cost=round(cost, 4), real_cost=round(rcost, 4), entry_mid=None if entry_mid is None else round(entry_mid, 4),
                half_spread=None if spread is None else round(spread, 4), oi=oi(t["date"], p[0]),
                old_1=sim.result(cost, steps, 0.01), old_2=sim.result(cost, steps, 0.02),
                real_1=sim.result(rcost, real, 0.01), real_2=sim.result(rcost, real, 0.02),
                fills=sum(s[2] in ("buy", "sell") for s in steps), no_quote=miss,
                exit=last_sell[-1][5] if last_sell else "", overnight=int(any(s[0] != t["date"] for s in steps)))


def stats(R, key):
    rows = sorted(R, key=lambda r: (r["date"], r["minute"]))
    pnl = lambda r, k: dict(date=r["date"], pnl=str(1e4 * max(-1, r[k])))
    a1, d1 = account([pnl(r, f"{key}_1") for r in rows])
    a2, d2 = account([pnl(r, f"{key}_2") for r in rows], 0.02)
    top = set(sorted(range(len(rows)), key=lambda i: -rows[i][f"{key}_1"])[:5])
    a5, _ = account([pnl(r, f"{key}_1") for i, r in enumerate(rows) if i not in top])
    yr = {y: round(sum(1e4 * max(-1, r[f"{key}_1"]) for r in rows if r["date"][:4] == y)) for y in ("2024", "2025", "2026")}
    best = [dict(sym=rows[i]["sym"], date=rows[i]["date"], pnl=round(1e4 * rows[i][f"{key}_1"])) for i in sorted(top, key=lambda i: -rows[i][f"{key}_1"])]
    return dict(trades=len(rows), winners=sum(r[f"{key}_1"] > 0 for r in rows),
                per_trade=round(sum(1e4 * max(-1, r[f"{key}_1"]) for r in rows) / max(1, len(rows))),
                acct1=round(a1), dd1=round(d1, 4), acct2=round(a2), dd2=round(d2, 4), no_best5=round(a5), years=yr, best5=best)


def main():
    jobs = []
    for slug, (_, prefix, _, fb) in eb.VERSIONS.items():
        T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
        nf.features(T)
        T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40
             and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= LAST]
        jobs += [(slug, t) for t in T if t["status"] == "ok" or fb]
    jobs.sort(key=lambda j: j[1]["date"])
    with mp.Pool(8) as pool: res = [r for r in pool.map(one, jobs, chunksize=16) if r]
    with open(f"{B}/real_bench_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(res[0])); w.writeheader(); w.writerows(res)
    out = {}
    print("| Version | Trades | No-quote fills | Old: 1% / drop | Real: 1% / drop | Old: 2% / drop | Real: 2% / drop | Real without best 5 | Real per trade at $10K |\n|---|---|---|---|---|---|---|---|---|")
    for slug, v in eb.VERSIONS.items():
        R = [r for r in res if r["version"] == slug]
        if not R: continue
        o, rl = stats(R, "old"), stats(R, "real")
        out[slug] = dict(name=v[0], old=o, real=rl, fills=sum(r["fills"] for r in R), no_quote=sum(r["no_quote"] for r in R))
        print(f"| {slug} | {o['trades']} | {out[slug]['no_quote']} of {out[slug]['fills']} | ${o['acct1']:,} / {o['dd1']:.0%} | ${rl['acct1']:,} / {rl['dd1']:.0%} | ${o['acct2']:,} / {o['dd2']:.0%} | ${rl['acct2']:,} / {rl['dd2']:.0%} | ${rl['no_best5']:,} | {o['per_trade']:+,} -> {rl['per_trade']:+,} |", flush=True)
    json.dump(out, open(f"{B}/real_bench_summary.json", "w"), indent=1)


if __name__ == "__main__": main()
