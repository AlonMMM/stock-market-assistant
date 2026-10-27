"""The Main bot on real quotes (the user, 2026-10-26, after the Volume bot's bars proved too kind). Each trade is walked
as always (sim.walk on trade bars: the same entries, contracts and exits), then every buy and sale is priced again
from the real best bid/ask (Databento OPRA cbbo-1m, dbx_fetch.py indi -> dbx_cache/indi/) at the moment the bot can
act: sim fills a step on the bar after the decision, so the book at the end of the minute before it. A buy pays the
mid + half the way to the ask (the bot's ladder), or the next minute's ask (at most +10%) when the price ran away; a
sale gets the bid (the bot's sellAtBid). The overnight cap and commissions as sim.result. A step with no quote then
keeps its bar price (counted). Versions: 2.6 (live: c12_15 entry, cheap fallback, no failed-break sale), 2.5, 2.4.
The fair list, 2% a trade.  node --env-file=.env <dir>/run.mjs indi_real.py      (from the app repo root)
"""
import bisect, csv, glob, gzip, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import cheap_up2 as cu2
import news_filter as nf
from store import calendar
from low_delta import HIS40, PRIOR
from d2_failed_break import CHAMP

B = "data/local/x/bt"
CAL = calendar()
SIZE = 0.02
BOTS = {"2.6 (live)": ("sg_c12_15", CHAMP, "cheap"), "2.5": ("sg_c12_15", CHAMP, None), "2.4": ("s_t18r15", cu2.BOT24, None)}
Q = {}


def book(date):
    if date not in Q:
        if len(Q) > 3: Q.clear()
        by = {}
        path = os.path.join(HERE, "dbx_cache", "indi", f"{date}.csv.gz")
        if os.path.exists(path):
            for r in csv.DictReader(gzip.open(path, "rt")):
                if r["bid"] and r["ask"] and float(r["ask"]) > 0 and float(r["bid"]) > 0:
                    by.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
        for v in by.values(): v.sort()
        Q[date] = by
    return Q[date]


def quote(c, date, minute):
    """The book at the end of `minute`, at most 5 minutes old."""
    v = book(date).get(c)
    if not v: return None
    i = bisect.bisect(v, (minute + 1, 1e9, 1e9)) - 1
    if i < 0 or v[i][0] < minute - 4: return None
    return v[i][1], v[i][2]


def one(job):
    bot, t = job
    _, exits, fb = BOTS[bot]
    p = eb.contract(t, fb)
    if not p: return None
    sim.X.clear(); sim.X.update(exits)
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], p[0], p[1], CAL)
    if cost is None: return None
    real, miss, bar_vs = [], 0, []
    rcost = cost
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
            bar_vs.append(("buy", px / (1 + sim.SH) / mid - 1))
            if rule != "rebuy": rcost = price
        else:
            price = bid
            bar_vs.append(("sell", px / (1 - sim.SH) / mid - 1))
        real.append((d, m, side, q, round(price, 4), rule))
    return bot, t["date"], sim.result(cost, steps, SIZE), sim.result(rcost, real, SIZE), miss, bar_vs, (ask - bid) / mid if steps and k else None


def account(R):
    eq, top, dd, by = 1e5, 1e5, 0.0, {}
    for d, ret in R: by.setdefault(d, []).append(ret)
    for d in sorted(by):
        eq *= 1 + sum(r * SIZE for r in by[d]); top = max(top, eq); dd = max(dd, 1 - eq / top)
    return eq, dd


def main():
    jobs = []
    for bot, (prefix, _, fb) in BOTS.items():
        T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
        nf.features(T)
        T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
        jobs += [(bot, t) for t in T if t["status"] == "ok" or fb]
    jobs.sort(key=lambda j: j[1]["date"])
    with mp.Pool(8) as pool: res = [r for r in pool.map(one, jobs, chunksize=16) if r]
    med = lambda x: sorted(x)[len(x) // 2] if x else float("nan")
    for title, a, z in (("2024-2025", "2024-01-01", "2025-12-31"), ("2026 (to Oct 12)", "2026-01-01", "2026-12-31"), ("all, Feb 2024 - Oct 2026", "", "9")):
        print(f"\n### Fair list {title}, 2% a trade\n\n| Version | Trades | Steps without a quote | Old test (bars): end, worst drop | Real bid/ask: end, worst drop | Avg per trade old / real |\n|---|---|---|---|---|---|")
        for bot in BOTS:
            R = [r for r in res if r[0] == bot and a <= r[1] <= z]
            e0, d0 = account([(r[1], r[2]) for r in R]); e1, d1 = account([(r[1], r[3]) for r in R])
            print(f"| {bot} | {len(R)} | {sum(r[4] for r in R)} | ${e0:,.0f}, {100 * d0:.1f}% | ${e1:,.0f}, {100 * d1:.1f}% | {100 * sum(r[2] for r in R) / len(R):+.1f}% / {100 * sum(r[3] for r in R) / len(R):+.1f}% |", flush=True)
    for bot in BOTS:
        R = [r for r in res if r[0] == bot]
        b = [x for r in R for s, x in r[5] if s == "buy"]; s_ = [x for r in R for s, x in r[5] if s == "sell"]
        print(f"\n{bot}: the old test's price vs the real mid when the bot acts: buys {100 * med(b):+.1f}% (median), sales {100 * med(s_):+.1f}%")


if __name__ == "__main__": main()
