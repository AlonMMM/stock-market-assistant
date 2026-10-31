"""Early entry re-tested the way the live bot runs it (the user, 2026-10-31, after a friend's review: "The current
champion peeks ahead. Its "early entry" buys partway through a minute using SPY's price at the end of that minute. It
also only tests signals already known to hold at the minute's close."; then "do it all").

sec_timing.py's "early" (the champion's early entry, 2.7) had three flaws: SPY inside the signal minute was that
minute's close spread evenly (look-ahead); only the champion's legs were searched, so a signal that held for a few
seconds and faded by the close (the live bot buys it: bot.ts earlyEntries) was never tested; and the forming minute's
volume was counted (live: 0) and checked every second (live: every 5 s). Here, every stock-day of the fair list and the
Favorites (24 months), every minute where a forming-minute fire is possible (an exact bound from the minute bars: t
peaks at x = S2 / S1), is checked on Alpaca's real trades: the stock's and SPY's last trade at each check second (the
live bot's lastPrices, a print 3% off the last close ignored), the forming minute's volume 0, t / D2 / the day volume
as cSignal (c12_15: t >= 1.8, or t >= 1.2 and D2 >= 1.5; volume >= 1.5x; 09:40-15:44). The day's first fire (early or
at a minute's close) is the stock-day's entry, faded or not. Versions, set before running:
  close-min   the champion: minute-close signals, the minute model's buy (the logged champion, the reference)
  close-1s    the same signals, bought on the option's 1-second book at the decision second (sec_timing "now-1s-r60")
  early-old   the champion's legs at sec_timing's early second (the look-ahead; the old champion, re-walked)
  early-5s    the fair early entry, checked every 5 seconds (the live bot's pace), bought 2 s after the check
  early-10s   the same every 10 seconds
Buys on the 1-second book (Databento, sec_cache/main) with the 60-second runaway look-ahead and the chase to the ask;
a buy with no book keeps the minute model (counted). An early fire picks its contract on the closed minute before.
The champion's exits (fixed walk) and pyramid add. Tune and check, 2% and 3%, picked on tune by min(fair, Favorites)
against close-1s.

  node --env-file=.env <dir>/run.mjs early_fair.py cand|secs|fires|books|run      (from the app repo root)
"""
import bisect, collections, csv, datetime as dt, glob, gzip, json, math, multiprocessing as mp, os, sys, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import fav_real as FR
import real_bench as RB
from levels import ctx
from low_delta import HIS40, PRIOR
from signals import series, beta
from store import calendar, day, _get

B = "data/local/x/bt"
OUT = f"{B}/early_fair"
NY = ZoneInfo("America/New_York")
CAL = calendar()
IDX = {d: i for i, d in enumerate(CAL)}
FIRST, LAST, MIN_STEPS, WINDOW = 10, 374, 10, 30
T_MIN, BONUS_T, BONUS_D2, RV_MIN = 1.8, 1.2, 1.5, 1.5
EPS = 1e-9
FAIR_FROM = "2024-02-01"


def spans():
    """sym -> [(from, to)]: the fair list (his 40, traded the year before) and the Favorites' 24 months."""
    out = collections.defaultdict(list)
    for s in HIS40:
        for y in ("2024", "2025", "2026"):
            if s in PRIOR[y]: out[s].append((max(FAIR_FROM, f"{y}-01-01"), min(RB.LAST, f"{y}-12-31")))
    for s in FR.FAV: out[s].append((FR.A24, FR.Z))
    return out


def tstat(n, s1, s2):
    mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
    return mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0


def t_range(n, s1, s2, xlo, xhi):
    """The lowest and highest t over a forming step x in [xlo, xhi] (t(x) turns at x = s2 / s1)."""
    xs = [xlo, xhi]
    if abs(s1) > EPS and xlo < s2 / s1 < xhi: xs.append(s2 / s1)
    ts = [tstat(n + 1, s1 + x, s2 + x * x) for x in xs]
    return min(ts), max(ts)


def passes(t, d2, rv):
    return rv >= RV_MIN and (t >= T_MIN or (t >= BONUS_T and d2 >= BONUS_D2))


def stock_days(sym, ranges):
    """Per stock-day: the closed-minute first fire (minute, side, t, rv, d2, price) and the minutes before it (and at it)
    where a forming-minute fire is possible, with the state the exact check needs."""
    out = []
    for i, date in enumerate(CAL):
        if i < 21 or not any(a <= date <= b for a, b in ranges): continue
        bars = day(sym, date)
        if len(bars) <= 300: continue
        b_ = beta(sym, date, i, CAL)
        if b_ is None: continue
        cx = ctx(sym, date)
        if not cx or not cx["sd"]: continue
        unit = cx["sd"]
        hist = []
        for d in CAL[i - 20:i]:
            v = [0] * 390
            for x in day(sym, d): v[x[0]] = x[5]
            acc, cum = 0, []
            for x in v: acc += x; cum.append(acc)
            if cum[-1] > 0: hist.append(cum)
        if len(hist) < 10: continue
        c, h, l, vol = series(bars)
        sc, sh, sl, _ = series(day("SPY", date))
        cum, acc = [], 0
        for x in vol: acc += x; cum.append(acc)
        n = s1 = s2 = 0.0
        d2c = [0.0] * 390; d2p = [0.0] * 390
        wc = wp = 0.0   # the D2 window's sums over the closed minutes (m-30..m-1 before m is added)
        cand, fire = [], None
        for m in range(1, LAST + 1):
            # the forming minute m (the live bot's early check): the closed minutes so far plus the last trade
            if m >= FIRST and n + 1 >= MIN_STEPS and c[m - 1] and sc[m - 1] and h[m] and l[m] and sh[m] and sl[m]:
                med = sorted(hh[m] for hh in hist); k = len(med) // 2
                usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
                rv = cum[m - 1] / usual if usual else 0.0   # the forming minute's volume: 0
                if rv >= RV_MIN:
                    gone = m - WINDOW
                    ec = wc - (d2c[gone] if gone >= 1 else 0.0)
                    ep = wp - (d2p[gone] if gone >= 1 else 0.0)
                    lo_s, hi_s = l[m] / c[m - 1] - 1, h[m] / c[m - 1] - 1
                    lo_p, hi_p = sl[m] / sc[m - 1] - 1, sh[m] / sc[m - 1] - 1
                    xs = [rs - b_ * rp for rs in (lo_s, hi_s) for rp in (lo_p, hi_p)]
                    xlo, xhi = min(xs), max(xs)
                    tlo, thi = t_range(n, s1, s2, xlo, xhi)
                    call = thi >= T_MIN or (thi >= BONUS_T and lo_p < 0 and ec + max(0.0, xhi / unit) >= BONUS_D2) or (thi >= BONUS_T and ec >= BONUS_D2)
                    put = -tlo >= T_MIN or (-tlo >= BONUS_T and hi_p > 0 and ep + max(0.0, -xlo / unit) >= BONUS_D2) or (-tlo >= BONUS_T and ep >= BONUS_D2)
                    if call or put:
                        cand.append(dict(m=m, n=n, s1=s1, s2=s2, ec=ec, ep=ep, rv=round(rv, 4), c0=c[m - 1], s0=sc[m - 1]))
            # the closed minute m
            if c[m] and c[m - 1] and sc[m] and sc[m - 1]:
                rs = c[m] / c[m - 1] - 1; rp = sc[m] / sc[m - 1] - 1
                x = rs - b_ * rp
                n += 1; s1 += x; s2 += x * x
                if rp < 0: d2c[m] = x / unit
                if rp > 0: d2p[m] = -x / unit
            wc += d2c[m]; wp += d2p[m]
            gone = m - WINDOW   # the window: minutes m-29..m, as cSignal
            if gone >= 1: wc -= d2c[gone]; wp -= d2p[gone]
            if m < FIRST or n < MIN_STEPS or c[m] is None: continue
            med = sorted(hh[m] for hh in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            rv = cum[m] / usual if usual else 0.0
            t = tstat(n, s1, s2)
            if passes(t, wc, rv): fire = dict(m=m, right="C", t=round(t, 2), rv=round(rv, 2), d2=round(wc, 2), price=c[m]); break
            if passes(-t, wp, rv): fire = dict(m=m, right="P", t=round(-t, 2), rv=round(rv, 2), d2=round(wp, 2), price=c[m]); break
        if fire or cand:
            out.append(dict(sym=sym, date=date, beta=b_, unit=unit, close=fire, cand=cand))
    return out


def job_cand(args):
    sym, ranges = args
    return stock_days(sym, ranges)


def cand():
    os.makedirs(OUT, exist_ok=True)
    S = spans()
    with mp.Pool(8) as pool: parts = pool.map(job_cand, sorted(S.items()), chunksize=1)
    rows = [r for p in parts for r in p]
    json.dump(rows, gzip.open(f"{OUT}/cand.json.gz", "wt"))
    nc = sum(len(r["cand"]) for r in rows)
    print(f"{len(rows)} stock-days; {sum(1 for r in rows if r['close'])} with a closed-minute fire; {nc} candidate forming minutes "
          f"on {sum(1 for r in rows if r['cand'])} stock-days; distinct (date, minute): {len({(r['date'], c['m']) for r in rows for c in r['cand']})}", flush=True)


def minute_utc(date, m, sec=0):
    t = dt.datetime.fromisoformat(date).replace(hour=9, minute=30, tzinfo=NY) + dt.timedelta(minutes=m, seconds=sec)
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def trades_path(date, m): return f"{OUT}/trades/{date}_{m}.json.gz"


def fetch_minute(job):
    """Every SIP trade of the symbols in minute m: {sym: [[second inside the minute, price], ...]}."""
    date, m, syms = job
    p = trades_path(date, m)
    if os.path.exists(p): return 0
    t0 = dt.datetime.fromisoformat(date).replace(hour=9, minute=30, tzinfo=NY) + dt.timedelta(minutes=m)
    got, token = collections.defaultdict(list), None
    while True:
        q = dict(symbols=",".join(syms), start=minute_utc(date, m), end=minute_utc(date, m + 1), limit=10000, feed="sip", sort="asc")
        if token: q["page_token"] = token
        j = _get("https://data.alpaca.markets/v2/stocks/trades?" + urllib.parse.urlencode(q))
        for s, ts in (j.get("trades") or {}).items():
            for x in ts:
                at = dt.datetime.fromisoformat(x["t"][:26].rstrip("Z") + "+00:00") if "." in x["t"] else dt.datetime.fromisoformat(x["t"].replace("Z", "+00:00"))
                got[s].append([round((at - t0).total_seconds(), 3), x["p"]])
        token = j.get("next_page_token")
        if not token: break
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(got, gzip.open(p + ".tmp", "wt")); os.replace(p + ".tmp", p)
    return sum(len(v) for v in got.values())


def secs():
    rows = json.load(gzip.open(f"{OUT}/cand.json.gz", "rt"))
    by = collections.defaultdict(set)
    for r in rows:
        for c in r["cand"]: by[(r["date"], c["m"])].add(r["sym"])
    jobs = sorted((d, m, sorted(s | {"SPY"})) for (d, m), s in by.items())
    print(len(jobs), "minutes to fetch", flush=True)
    n = 0
    with ThreadPoolExecutor(8) as ex:
        for k in ex.map(fetch_minute, jobs):
            n += 1
            if n % 500 == 0: print(n, flush=True)
    print("done", flush=True)


# ---- the fires: the day's first moment the rule holds, on the real trades ----

CHECKS = {"early-5s": tuple(range(5, 60, 5)), "early-10s": tuple(range(10, 60, 10))}
ODD = 0.03   # bot.ts: a print this far off the last close is not the minute so far


def last_at(ts, s, fallback):
    i = bisect.bisect_right(ts[0], s) - 1
    return ts[1][i] if i >= 0 else fallback


def fires():
    rows = json.load(gzip.open(f"{OUT}/cand.json.gz", "rt"))
    out = {v: [] for v in CHECKS}
    out["close"] = []
    missing = 0
    cache = {}
    for r in rows:
        if r["close"]: out["close"].append(dict(sym=r["sym"], date=r["date"], kind="close", sec=60, **r["close"]))
        for v, checks in CHECKS.items():
            got = None
            for c in r["cand"]:
                k = (r["date"], c["m"])
                if k not in cache:
                    p = trades_path(*k)
                    if not os.path.exists(p): cache[k] = None
                    else:
                        d = json.load(gzip.open(p, "rt"))
                        cache[k] = {sym: ([x[0] for x in xs], [x[1] for x in xs]) for sym, xs in d.items()}
                    if len(cache) > 400: cache.pop(next(iter(cache)))
                tr = cache[k]
                if tr is None: missing += 1; continue
                st_ = tr.get(r["sym"], ([], [])); sp = tr.get("SPY", ([], []))
                for sec in checks:
                    p_ = last_at(st_, sec, c["c0"]); q_ = last_at(sp, sec, c["s0"])
                    if abs(p_ / c["c0"] - 1) > ODD or abs(q_ / c["s0"] - 1) > ODD: continue
                    rs, rp = p_ / c["c0"] - 1, q_ / c["s0"] - 1
                    x = rs - r["beta"] * rp
                    t = tstat(c["n"] + 1, c["s1"] + x, c["s2"] + x * x)
                    ec = c["ec"] + (x / r["unit"] if rp < 0 else 0.0)
                    ep = c["ep"] + (-x / r["unit"] if rp > 0 else 0.0)
                    if passes(t, ec, c["rv"]): got = dict(m=c["m"], right="C", t=round(t, 2), rv=c["rv"], d2=round(ec, 2), price=p_, sec=sec); break
                    if passes(-t, ep, c["rv"]): got = dict(m=c["m"], right="P", t=round(-t, 2), rv=c["rv"], d2=round(ep, 2), price=p_, sec=sec); break
                if got: break
            if got: out[v].append(dict(sym=r["sym"], date=r["date"], kind="early", **got))
            elif r["close"]: out[v].append(dict(sym=r["sym"], date=r["date"], kind="close", sec=60, **r["close"]))
    json.dump(out, gzip.open(f"{OUT}/fires.json.gz", "wt"))
    close = {(f["sym"], f["date"]): f for f in out["close"]}
    for v in CHECKS:
        F = out[v]
        early = [f for f in F if f["kind"] == "early"]
        fade = [f for f in early if (f["sym"], f["date"]) not in close]
        before = [f for f in early if (f["sym"], f["date"]) in close and f["m"] < close[(f["sym"], f["date"])]["m"]]
        same = [f for f in early if (f["sym"], f["date"]) in close and f["m"] == close[(f["sym"], f["date"])]["m"]]
        flip = [f for f in early if (f["sym"], f["date"]) in close and f["right"] != close[(f["sym"], f["date"])]["right"]]
        print(f"{v}: {len(F)} stock-days, {len(early)} early fires: {len(same)} inside the closed signal's minute, {len(before)} in an earlier "
              f"minute, {len(fade)} on a day with no closed-minute signal (faded); {len(flip)} on the other side", flush=True)
    print("candidate minutes with no trades file:", missing)


# ---- the walks: pick, the champion's exits, the buy on the 1-second book ----

VERSIONS = ("close-min", "close-1s", "early-old", "early-5s", "early-10s")
SIZES = (0.02, 0.03)
LAG = 2


def in_list(src, sym, date):
    if src == "fair": return sym in HIS40 and sym in PRIOR[date[:4]] and FAIR_FROM <= date <= RB.LAST
    return sym in FR.FAV and FR.A24 <= date <= FR.Z


def entries_of(F):
    """(src, version) -> [entry]: the fires on each list, the news filter applied (fair_signals' rule)."""
    import news_filter as nf
    out = {}
    for v, src_v in (("close-min", "close"), ("close-1s", "close"), ("early-old", "close"), ("early-5s", "early-5s"), ("early-10s", "early-10s")):
        rows = [dict(f, minute=str(f["m"])) for f in F[src_v]]
        nf.features(rows)
        rows = [r for r in rows if r["e_next"] != 0 and (r["pre_rvol"] is None or r["pre_rvol"] < 4)]
        for src in ("fair", "fav"): out[(src, v)] = [r for r in rows if in_list(src, r["sym"], r["date"])]
    return out


def walk_job(job):
    """One entry: the pick (an early fire picks on the closed minute before), the walk from its minute, the buys."""
    import retry_roll as rr, sim, fill_models as fm, sec_timing as ST
    src, sym, date, m, right, kind, price, secs, ct = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    pm = m if kind == "close" else m - 1
    if kind != "close":
        try: sim.pick(sym, date, pm, right, price)   # downloads the chain's bars once for a stock-day the champion never traded
        except Exception: pass
    c = rr.pick(sym, date, pm, right, price)
    if not c: return job, None
    g = rr.leg(sym, date, m, right, c)
    if not g: return job, None
    rcost, real, bk = g
    book = ST.load_book(date, c[0], m)
    buys = {}
    if book:
        for sec in secs: buys[sec] = ST.plain(book, 60 * m + sec - 1 + LAG if sec == 60 else 60 * m + sec + LAG, 60)
        if kind == "close":
            stock = ST.load_stock(date, sym)
            es = None
            if stock:
                try: es = ST.early_second(dict(sym=sym, date=date, minute=str(m), right=right), stock)
                except Exception: es = None
            buys["old"] = ST.plain(book, es + LAG, 60) if es is not None else buys.get(60)
    return job, dict(contract=c[0], rcost=rcost, real=real, book=bk, buys=buys, has1s=bool(book))


def jobs_of(E):
    want = collections.defaultdict(set)
    meta = {}
    for (src, v), rows in E.items():
        for r in rows:
            k = (src, r["sym"], r["date"], int(r["m"]), r["right"], r["kind"], r["price"])
            want[k].add(int(r["sec"])); meta[k] = r["t"]
    return [k + (tuple(sorted(want[k])), meta[k]) for k in sorted(want)]


def books():
    """The 1-second option books the early fires need and the cache lacks: priced, then fetched under the cap."""
    import sec_fetch_main as SF, dbx_fetch as DF
    F = json.load(gzip.open(f"{OUT}/fires.json.gz", "rt"))
    E = entries_of(F)
    J = [j for j in jobs_of(E)]
    with mp.Pool(8) as pool: W = pool.map(walk_job, J, chunksize=4)
    need = sorted({(j[2], w["contract"], j[3]) for j, w in W if w and not w["has1s"]})
    print(f"{len(J)} entries, {sum(1 for _, w in W if w)} walked; {len(need)} option windows without a 1-second book", flush=True)
    def cost(job):
        date, c, m = job
        one_s = date >= SF.SEC1
        q = dict(dataset="OPRA.PILLAR", schema="cbbo-1s" if one_s else "cmbp-1", stype_in="raw_symbol", symbols=DF.pad(c),
                 start=SF.utc(date, (m - 2) * 60 - (0 if one_s else 60)), end=SF.utc(date, (m + 10) * 60))
        req = urllib.request.Request("https://hist.databento.com/v0/metadata.get_cost", data=urllib.parse.urlencode(q).encode(), headers={"Authorization": DF.AUTH})
        for tries in range(5):
            try: return float(urllib.request.urlopen(req, timeout=120).read().decode())
            except urllib.error.HTTPError as e:
                if e.code == 422: return 0.0
                if tries == 4: raise
            except Exception:
                if tries == 4: raise
            import time; time.sleep(5 * (tries + 1))
    with ThreadPoolExecutor(8) as ex: costs = list(ex.map(cost, need))
    total = sum(costs)
    print(f"get_cost for the missing books: ${total:.2f} (cap $20)", flush=True)
    if total > 20 or os.environ.get("EF_PRICE_ONLY"): print("not fetched"); return
    with ThreadPoolExecutor(6) as ex:
        for n, k in enumerate(ex.map(SF.option, need), 1):
            if n % 200 == 0: print("option", n, flush=True)
    print("fetched", flush=True)


def run():
    import retry_roll as rr, sim, floor_exception as fe
    from score_sum import held as booked
    from split import half
    F = json.load(gzip.open(f"{OUT}/fires.json.gz", "rt"))
    E = entries_of(F)
    J = jobs_of(E)
    adds = {"fair": fe.fair_signals("s_t18r15"), "fav": FR.signals("24")}
    AJ = [(src, t["sym"], t["date"], int(t["minute"]), t["right"], "close", float(t["price"]), (60,), t.get("c_t")) for src in adds for t in adds[src]]
    with mp.Pool(8) as pool: W = dict(pool.map(walk_job, J + AJ, chunksize=4))
    IX = {k[:7]: k for k in J}
    A = collections.defaultdict(list)
    for j in AJ:
        w = W.get(j)
        if w: A[(j[0], j[2], j[1], j[4])].append((j[3], w))

    def leg_of(w, buy):
        """(paid, steps): the walk's buy, or the 1-second buy when it lands before the first sale."""
        paid, steps = w["rcost"], w["real"]
        if buy:
            s_, p_ = buy
            first_sale = min((x[1] for x in steps if x[2] == "sell" and x[0] == steps[0][0]), default=999)
            if s_ // 60 < first_sale: paid, steps = p_, [(steps[0][0], s_ // 60, "buy", 1.0, p_, "entry")] + list(steps[1:])
        return paid, steps

    def entries(src, v, part, size):
        out, cov = [], [0, 0]
        for r in E[(src, v)]:
            if half(r["date"]) != part: continue
            w = W.get(IX.get((src, r["sym"], r["date"], int(r["m"]), r["right"], r["kind"], r["price"])))
            if not w: continue
            buy = None
            if v == "close-1s": buy = w["buys"].get(60)
            elif v == "early-old": buy = w["buys"].get("old")
            elif v.startswith("early"): buy = w["buys"].get(int(r["sec"]))
            cov[0] += 1; cov[1] += bool(buy) or v == "close-min"
            paid, steps = leg_of(w, buy)
            res = sim.result(paid, steps, size)
            over = int(any(x[0] != r["date"] for x in steps if x[2] == "sell"))
            out.append((r["date"], int(r["m"]), 1.0, res, over, booked(paid, steps)))
            if float(r["t"]) >= T_MIN: continue   # the pyramid adds to D2 entries only
            sells = [x for x in steps if x[2] == "sell"]
            for am, aw in sorted(A.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q[0]):
                if am <= int(r["m"]): continue
                share = 1 - sum(x[3] for x in sells if x[0] == r["date"] and x[1] <= am)
                q = RB.quote(w["contract"], r["date"], am)
                up = None if not q else (q[0] + q[1]) / 2 / paid - 1
                if share > 0 and up is not None and up > 0:
                    out.append((r["date"], am, 0.5, sim.result(aw["rcost"], aw["real"], size / 2), int(any(x[0] != r["date"] for x in aw["real"] if x[2] == "sell")), booked(aw["rcost"], aw["real"])))
                break
        return out, cov

    res = {}
    for size in SIZES:
        for part in ("tune", "check"):
            for v in VERSIONS:
                res[(size, part, v)] = []
                for src in ("fair", "fav"):
                    E_, cov = entries(src, v, part, size)
                    res[(size, part, v)].append(dict(rr.stats(E_, size), cov=cov))
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5; trades; 1-second buys)\n\n"
              "| Version | Tune fair | Tune fav | Check fair | Check fav | Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) | Trades tune / check (fair) | 1-s buys (tune fair) |\n|---|---|---|---|---|---|---|---|---|")
        for v in VERSIONS:
            (tf, tv), (cf, cv) = res[(size, "tune", v)], res[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} | {tf['trades']} / {cf['trades']} | {tf['cov'][1]} of {tf['cov'][0]} |", flush=True)
    base = res[(0.02, "tune", "close-1s")]
    sc = lambda v: min(res[(0.02, "tune", v)][i]["acct"] / base[i]["acct"] for i in (0, 1))
    best = max(("early-5s", "early-10s"), key=sc)
    bc, pc = res[(0.02, "check", "close-1s")], res[(0.02, "check", best)]
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs close-1s at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
          f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}", flush=True)
    # the fades: early fires on a stock-day with no closed-minute signal; and the early fires before the closed minute
    close = {(f["sym"], f["date"]) for f in F["close"]}
    for v in ("early-5s", "early-10s"):
        for part in ("tune", "check"):
            for src in ("fair", "fav"):
                groups = collections.defaultdict(list)
                for r in E[(src, v)]:
                    if half(r["date"]) != part or r["kind"] != "early": continue
                    w = W.get(IX.get((src, r["sym"], r["date"], int(r["m"]), r["right"], r["kind"], r["price"])))
                    if not w: continue
                    paid, steps = leg_of(w, w["buys"].get(int(r["sec"])))
                    g = "faded (no closed signal that day)" if (r["sym"], r["date"]) not in close else "held to a closed signal"
                    groups[g].append(1e4 * max(-1, sim.result(paid, steps, 0.02)))
                for g, xs in sorted(groups.items()):
                    xs.sort()
                    print(f"{v} {part} {src}: {g}: {len(xs)} trades, median {xs[len(xs) // 2]:+,.0f}, sum {sum(xs):+,.0f}, giants {sum(x >= 3e4 for x in xs)}, "
                          f"won {sum(x > 0 for x in xs)}", flush=True)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in res.items()}, open(f"{B}/early_fair_summary.json", "w"), indent=1)


if __name__ == "__main__":
    {"cand": cand, "secs": secs, "fires": fires, "books": books, "run": run}[sys.argv[1]]()
