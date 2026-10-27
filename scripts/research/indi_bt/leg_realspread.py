"""The spread step-up (the user, 2026-10-26: "default the delta 0.2, and if we have a spread that is more than 5%
... move up for 0.25, 0.30, 0.35 ... no more than 0.35"; then "try with 10 15% 20% and 30%, and on 0.35 take the
cheapest - but never over 40%"). The live Volume bot rule otherwise (0DTE + 1DTE, side at 0.25 S30 in 10 minutes,
re-entry 2 a stock a day, 0.75 S30 give-back, 1%, live limits 15 a day / 5 open / 7.5% day loss).

REAL quotes: the best bid/ask each minute from Databento OPRA cbbo-1m (dbx_fetch.py -> dbx_cache/). A buy fills at the
mid + half the way to the ask (the bot's ladder, mid -> mid + 85% to the ask in 5 steps 3 seconds apart, about at its
3rd step; the user, 2026-10-26: "for buy use the price you think it going to make"), unless the bid a minute later is
already above that price (it ran away, nothing filled): then the bot's chase, that minute's ask, at most +10% (its
budget cap). A sale fills at the bid at the end of the exit minute (the bot's sellAtBid). $0.62 a contract each way.
What a better sale is worth (the user: "how much it will cost to optimize the selling price"): the same trades sold
with a ladder like the buy's, the mid - half the way to the bid, unless the ask a minute later is already below that
(it fell away): then that minute's bid. The
spread rules read each candidate's real spread at the side minute. A contract without a quote then: the sample model
of leg_spread.py (counted as "modelled"). Versions, all with the liquid rule
(a step's contract must have 200+ contracts in 30 minutes and $0.20; else the nearest that does, within ±0.05):
  now35     the bot now: 0.35, the liquid fallback
  plain20   0.20, the liquid fallback, no spread rule
  stepT     0.20; spread over T%: 0.25, 0.30, 0.35; none under T: the narrowest of them if under 40%, else no trade

  BT_UNIVERSE=watch BT_ALL=1 node --env-file=.env <path>/run.mjs leg_realspread.py
"""
import bisect, csv, gzip, hashlib, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day
from levels import ctx
from rvol_alert import alerts_for
from zero5 import FIRST, LAST
from cheap_up import candidates
import leg_twice as TW
import leg_fallback as LF
import leg_daycap as D

C = sim.C
CAL = TW.CAL
BANDS = [0.2, 0.35, 0.5, 0.75, 1, 1.5, 2.5, 5]
SAMPLE = {}
for r in csv.DictReader(open(os.path.join(HERE, "spread_sample_2026-10-26.csv"))):
    if int(r["day_volume"]) < 200 or not 0.1 <= float(r["delta"]) <= 0.5: continue
    SAMPLE.setdefault(bisect.bisect(BANDS, float(r["mid"])), []).append(float(r["spread_pct"]) / 100)
for v in SAMPLE.values(): v.sort()
STEPS = (0.20, 0.25, 0.30, 0.35)
THRESHOLDS = (0.05, 0.10, 0.15, 0.20, 0.30)
CAP = 0.40


def level(contract, date):
    """The spread level, a quantile: one per stock and day by default (a stock with wide spreads has them on every
    strike, so the steps gain only by price); BT_SPREAD_LEVEL=strike draws each strike on its own (too kind)."""
    key = contract if os.environ.get("BT_SPREAD_LEVEL") == "strike" else contract[:-15]
    return int(hashlib.md5(f"{key}|{date}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


QUOTES = {}


def quotes(date):
    if date not in QUOTES:
        QUOTES.clear()
        by = {}
        for path in (os.path.join(HERE, "dbx_cache", f"{date}.csv.gz"), os.path.join(HERE, "dbx_cache", "extra", f"{date}.csv.gz")):
            if not os.path.exists(path): continue
            for r in csv.DictReader(gzip.open(path, "rt")):
                if r["bid"] and r["ask"] and float(r["ask"]) > 0: by.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
        for v in by.values(): v.sort()
        QUOTES[date] = by
    return QUOTES[date]


def quote(contract, date, minute):
    """The bid and ask at the end of the minute (a cbbo-1m row stamped m+1 is the book as minute m closed), at most
    5 minutes old. -> (bid, ask) or None."""
    v = quotes(date).get(contract)
    if not v: return None
    i = bisect.bisect(v, (minute + 1, 1e9, 1e9)) - 1
    if i < 0 or v[i][0] < minute - 4: return None
    return v[i][1], v[i][2]


def fill(contract, date, minute, q):
    """The buy price: the mid + half the way to the ask, or the chase when the price ran away."""
    bid, ask = q
    price = (bid + ask) / 2 + (ask - (bid + ask) / 2) / 2
    later = quote(contract, date, minute + 1)
    if later and later[0] > price: return min(later[1], price * 1.1)
    return price


def sell_ladder(contract, date, minute, q):
    """The sale with a ladder: the mid - half the way to the bid, or the next minute's bid when the price fell away."""
    bid, ask = q
    price = (bid + ask) / 2 - ((bid + ask) / 2 - bid) / 2
    later = quote(contract, date, minute + 1)
    if later and later[1] < price: return later[0]
    return price


def real(contract, date, minute, mid, q):
    """The spread % of the contract then, real when quoted, else the sample model."""
    x = quote(contract, date, minute)
    if not x: return spread(mid, q)
    return (x[1] - x[0]) / ((x[1] + x[0]) / 2)


def spread(mid, q):
    v = SAMPLE[bisect.bisect(BANDS, mid)]
    return v[min(len(v) - 1, int(q * len(v)))]


def nearest(cands, target):
    ok = [c for c in cands if c[4] >= C["min_price"] and c[5] >= 200 and abs(abs(c[3]) - target) <= 0.05]
    return min(ok, key=lambda c: abs(abs(c[3]) - target)) if ok else None


def pick(cands, how, date, ct):
    if how == "now35": return LF.choose(cands, "liquid")
    if how == "now35cap":   # the bot now, skipping a contract whose spread is over 40%
        c = LF.choose(cands, "liquid")
        return c if c and real(c[0], date, ct, c[4], level(c[0], date)) <= CAP else None
    if how == "plain20":
        old = LF.DELTA, LF.LOW
        LF.DELTA, LF.LOW = 0.20, 0.10
        c = LF.choose(cands, "liquid")
        LF.DELTA, LF.LOW = old
        return c
    # stepT, or stepTcC: the cap C% instead of 40% (the user, 2026-10-26: "step up 0.2, 8%, block 25% spread")
    T, cap = how[4:], "40"
    if "c" in T: T, cap = T.split("c")
    T, cap = float(T) / 100, float(cap) / 100
    tried = []
    for target in STEPS:
        c = nearest(cands, target)
        if not c: continue
        s = real(c[0], date, ct, c[4], level(c[0], date))
        if s <= T: return c
        tried.append((s, c))
    if not tried: return None
    s, c = min(tried, key=lambda x: x[0])
    return c if s <= cap else None


VERSIONS = ["now35", "now35cap", "plain20"] + [f"step{int(t * 100)}" for t in THRESHOLDS]
if os.environ.get("BT_SPREAD_ONLY"): VERSIONS = os.environ["BT_SPREAD_ONLY"].split(",")


def one(job):
    date, sym, kind = job
    al = alerts_for(sym, date, CAL)
    if not al: return None
    ev = [(q, al[q]) for q in range(FIRST, LAST + 1) if al[q] and not al[q - 1]]
    if not ev: return None
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if not x or not x.get("sd"): return None
    u = x["sd"]
    if kind == "0": C.update(dte_min=0, dte_max=0, delta=0.35)
    else: C.update(dte_min=1, dte_max=5, delta=0.35)
    nxt = CAL[CAL.index(date) + 1] if kind == "1" else date
    per = {v: [] for v in VERSIONS}
    for n, (m, side_al) in enumerate(ev):
        if m not in sb: continue
        stock0 = sb[m][4]; side = None
        for t in range(m + 1, m + TW.WAIT + 1):
            if t in sb and abs(sb[t][4] / stock0 - 1) >= TW.K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
        cands = []
        if side:
            ct, right = side; spot = sb[ct][4]
            got, why = sim.pick(sym, date, ct, right, spot)
            if why not in ("no_expiry", "no_strikes"):
                cands = [c for c in candidates(sym, date, ct, right, spot) if c[1] == nxt]
        for v in VERSIONS:
            tr = None
            c = pick(cands, v, date, ct) if cands else None
            if c:
                w = LF.walk(sym, date, ct, right, c[0], spot, u)
                if w:
                    q = level(c[0], date)
                    mid_b, mid_s = w[0] / (1 + LF.SH), w[1] / (1 - LF.SH)
                    qb, qs = quote(c[0], date, w[2]), quote(c[0], date, w[3])
                    modelled = not qb or not qs
                    if qb: buy = fill(c[0], date, w[2], qb)
                    else: buy = mid_b * (1 + spread(mid_b, q) / 2)
                    if qs: sell, sell2 = qs[0], sell_ladder(c[0], date, w[3], qs)
                    else: sell = sell2 = max(mid_s * (1 - spread(max(mid_s, 0.01), q) / 2), 0.0)
                    bmid = (qb[0] + qb[1]) / 2 if qb else mid_b
                    smid = (qs[0] + qs[1]) / 2 if qs else mid_s
                    ssp = (qs[1] - qs[0]) / smid if qs and smid > 0 else None
                    tr = dict(barb=mid_b, bars=mid_s, bmid=bmid, smid=smid, ssp=ssp, buy=buy, sell=sell, sell2=sell2, bm=w[2], xm=w[3], ct=ct, contract=c[0], delta=abs(c[3]),
                              sp=real(c[0], date, w[2], mid_b, q), modelled=modelled)
            per[v].append(dict(n=n, minute=m, trade=tr))
    return dict(first_minute=ev[0][0], modes=per)


def main():
    import news_filter as nf
    jobs = TW.days()
    with mp.Pool(8) as pool: res = pool.map(one, jobs, chunksize=4)
    rows = [dict(date=j[0], sym=j[1], minute=r["first_minute"], right="C", r=r) for j, r in zip(jobs, res) if r]
    nf.features(rows)
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    for lab, lo in (("3 years (Feb 2024 - Oct 2026)", "0000"), ("12 months", "2025-10-23"), ("6 months", "2026-04-23")):
        print(f"\n### {lab}\n\n| Version | Trades | Modelled | Avg delta | Avg spread | Sell at bid: end, worst drop | without best 5 | Sell ladder: end, worst drop | Ladder gain |\n|---|---|---|---|---|---|---|---|---|")
        for v in VERSIONS:
            T = []
            for t in keep:
                if t["date"] < lo: continue
                for e in TW.pick(dict(events=t["r"]["modes"][v]), "flat")[:2]:
                    x = e["trade"]
                    T.append(dict(date=t["date"], sym=t["sym"], minute=e["minute"], delta=x["delta"], sp=x["sp"], mod=x["modelled"], sell2=x["sell2"], **{k: x[k] for k in ("buy", "sell", "bm", "xm")}))
            eL, dL, R, _, _ = D.account(T, 1, 2, loss=7.5, max_trades=15, max_open=5)
            eS, dS = D.account([dict(t, sell=t["sell2"]) for t in T], 1, 2, loss=7.5, max_trades=15, max_open=5)[:2]
            top = {(r["date"], r["sym"], r["minute"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
            e5 = D.account([t for t in T if (t["date"], t["sym"], t["minute"]) not in top], 1, 2, loss=7.5, max_trades=15, max_open=5)[0]
            ad = sum(r["delta"] for r in R) / max(1, len(R)); asp = 100 * sum(r["sp"] for r in R) / max(1, len(R))
            nm = sum(1 for r in R if r.get("mod"))
            print(f"| {v} | {len(R)} | {nm} | {ad:.2f} | {asp:.1f}% | ${eL:,.0f}, {100 * dL:.1f}% | ${e5:,.0f} | ${eS:,.0f}, {100 * dS:.1f}% | ${eS - eL:+,.0f} |", flush=True)

    if os.environ.get("BT_EXPORT"):   # for the benchmark page: each version's trades, prices with the spread in them
        out = os.environ["BT_EXPORT"]
        names = {"now35": "rsnow", "now35cap": "rscap", "plain20": "rs20"}
        T = []
        for v in VERSIONS:
          for ladder in (False, True):   # <set>L: the same trades sold with the ladder (sell2) instead of at the bid
            name = names.get(v, f"rs{v}") + ("L" if ladder else "")
            for t in sorted(keep, key=lambda t: t["date"]):
                for e in TW.pick(dict(events=t["r"]["modes"][v]), "flat")[:2]:
                    x = e["trade"]
                    T.append(dict(key=f"{name}|watch|{t['date']}|{t['sym']}|{x['contract']}|{e['minute']}", set=name, list="watch", date=t["date"],
                                  sym=t["sym"], minute=e["minute"], prev_date=CAL[CAL.index(t["date"]) - 1], kept="call" if x["contract"][-9] == "C" else "put",
                                  side_minute=x["ct"], leg=x["contract"], delta=round(x["delta"], 2), buy_minute=x["bm"], buy_price=round(x["buy"], 4),
                                  exit_day="t", exit_minute=x["xm"], exit_price=round(x["sell2"] if ladder else x["sell"], 4), spread=round(x["sp"], 4),
                                  buy_mid=round(x["bmid"], 4), exit_mid=round(x["smid"], 4), bar_buy=round(x["barb"], 4), bar_exit=round(x["bars"], 4), exit_spread="" if x["ssp"] is None else round(x["ssp"], 4)))
        with open(f"{out}/trades_watch_realspread.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(T[0])); w.writeheader(); w.writerows(T)
        print("trades_watch_realspread", len(T), "rows", flush=True)


if __name__ == "__main__":
    main()
