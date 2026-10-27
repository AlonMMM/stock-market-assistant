"""Enter the second the side is crossed, not on the 1-minute close (the user, 2026-10-26: "why do we wait to the candle
to close?"). The Volume bot's alerts over the last 12 months on the watchlist (167 stocks); for each, the stock's
1-second bars (Databento EQUS.MINI ohlcv-1s) over the 10 minutes after the alert, and the chosen contract's 1-second
bid/ask (OPRA cbbo-1s) around the entry. Entries:
  close     now: the first 1-minute close 0.25 x S30 from the alert price; the book at the end of that minute
  cross     the first second the stock trades 0.25 x S30 away
  holdN     the first time it stays beyond the line N seconds in a row (5, 10)
A second entry buys LAG seconds after the trigger (the bot's reaction), at the mid + half the way to the ask of that
second's book; if the bid 10 seconds on is already above that, the ask then, at most +10% (the chase). Contract: the
version's own pick on the last whole minute before the entry. The exit as always (the 0.75 x S30 give-back on minute
closes, out by 15:30), sold at the real bid (cbbo-1m). Live limits, 1% a trade, re-entry up to 2 a stock a day.
  node --env-file=.env <dir>/run.mjs leg_seconds.py list|stock|pick|option|run      (from the app repo root)
"""
import base64, csv, gzip, http.client, io, json, multiprocessing as mp, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import leg_realspread as RS
import sim
from store import day, P
from levels import ctx
from rvol_alert import alerts_for
from zero5 import FIRST, LAST
from cheap_up import candidates
import leg_twice as TW
import leg_fallback as LF
import leg_daycap as D

C, CAL = sim.C, TW.CAL
FROM = os.environ.get("SEC_FROM", "2025-10-23")   # SEC_FROM=2024-02-01 SEC_TAG=3y: the 3 years (cmbp-1 before cbbo-1s exists)
TAG = os.environ.get("SEC_TAG", "")
SEC1 = "2025-02-20"
OUT = os.path.join(HERE, "sec_cache")
NY = ZoneInfo("America/New_York")
LAG = 2
ENTRIES = ("close", "cross", "hold5", "hold10")
VERSIONS = ("plain20", "step8c25")


def utc(date, sec):
    h, r = divmod(34200 + sec, 3600); m, s = divmod(r, 60)
    return datetime.fromisoformat(f"{date}T{h:02d}:{m:02d}:{s:02d}").replace(tzinfo=NY).astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S")


def get(dataset, schema, symbol, date, a, z):
    auth = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
    data = urllib.parse.urlencode(dict(dataset=dataset, schema=schema, stype_in="raw_symbol", encoding="csv", pretty_px="true",
                                       pretty_ts="true", symbols=symbol, start=utc(date, a), end=utc(date, z))).encode()
    req = urllib.request.Request("https://hist.databento.com/v0/timeseries.get_range", data=data, headers={"Authorization": auth})
    for tries in range(6):
        try: return urllib.request.urlopen(req, timeout=300).read().decode()
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead) as e:
            if tries == 5: raise
            time.sleep(10 * (tries + 1))


def sec_of(ts):
    t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(NY)
    return t.hour * 3600 + t.minute * 60 + t.second - 34200


def events_of(job):
    date, sym, kind = job
    if date < FROM: return []
    al = alerts_for(sym, date, CAL)
    if not al: return []
    x = ctx(sym, date)
    if not x or not x.get("sd"): return []
    sb = {b[0]: b for b in day(sym, date)}
    nxt = CAL[CAL.index(date) + 1] if kind == "1" else date
    return [dict(date=date, sym=sym, kind=kind, nxt=nxt, m=q, u=x["sd"], stock0=sb[q][4]) for q in range(FIRST, LAST + 1)
            if al[q] and not al[q - 1] and q in sb]


def stock_path(e):
    if "sec0" in e: return os.path.join(OUT, "stock", f"{e['date']}_{e['sym']}_s{e['sec0']}.csv.gz")
    return os.path.join(OUT, "stock", f"{e['date']}_{e['sym']}_{e['m']}.csv.gz")


def fast_events():
    """The fast alert's events (fast_alerts.py): the alert's 10-second slot end, the stock's price then."""
    import leg_1dte as L1
    out = []
    for a in json.load(open(os.path.join(OUT, "fast_alerts.json"))):
        if a["date"] < FROM or a["date"] not in CAL: continue
        k = L1.kind_of(a["sym"], a["date"])
        x = ctx(a["sym"], a["date"])
        if not k or not x or not x.get("sd"): continue
        nxt = CAL[CAL.index(a["date"]) + 1] if k == "1" else a["date"]
        out.append(dict(date=a["date"], sym=a["sym"], kind=k, nxt=nxt, m=a["sec"] // 60, sec0=a["sec"], u=x["sd"], stock0=a["price"]))
    return out


def fetch_stock(e):
    p = stock_path(e)
    if os.path.exists(p): return
    a = e["sec0"] if "sec0" in e else (e["m"] + 1) * 60
    z = a + TW.WAIT * 60
    text = get("EQUS.MINI", "ohlcv-1s", e["sym"], e["date"], a, z)
    rows = [(sec_of(r["ts_event"]), r["close"]) for r in csv.DictReader(io.StringIO(text))]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with gzip.open(p + ".tmp", "wt") as f: csv.writer(f).writerows(rows)
    os.replace(p + ".tmp", p)


def triggers(e):
    """{entry: (trigger second, side, stock price) or None}."""
    sb = {b[0]: b for b in day(e["sym"], e["date"])}
    th = TW.K * e["u"]; out = {k: None for k in ENTRIES}
    for t in range(e["m"] + 1, e["m"] + TW.WAIT + 1):
        if t in sb and abs(sb[t][4] / e["stock0"] - 1) >= th:
            out["close"] = ((t + 1) * 60, "C" if sb[t][4] > e["stock0"] else "P", sb[t][4]); break
    p = stock_path(e)
    if not os.path.exists(p): return out
    secs = [(int(s), float(c)) for s, c in csv.reader(gzip.open(p, "rt"))]
    run, side0 = 0, None
    for s, c in secs:
        side = None
        if c >= e["stock0"] * (1 + th): side = "C"
        if c <= e["stock0"] * (1 - th): side = "P"
        if side and out["cross"] is None: out["cross"] = (s, side, c)
        if side and side == side0: run += 1
        elif side: run, side0 = 1, side
        else: run, side0 = 0, None
        for n in (5, 10):
            if side and run >= n and out[f"hold{n}"] is None: out[f"hold{n}"] = (s, side, c)
    return out


def pick_for(job):
    """The contract each version buys for each entry: picked on the last whole minute before the entry."""
    e, trig = job
    C.update(dte_min=0, dte_max=0, delta=0.35) if e["kind"] == "0" else C.update(dte_min=1, dte_max=5, delta=0.35)
    out = {}
    for entry, tg in trig.items():
        if not tg: continue
        sec, side, spot = tg
        cm = sec // 60 - 1
        got, why = sim.pick(e["sym"], e["date"], cm, side, spot)
        if why in ("no_expiry", "no_strikes"): continue
        cands = [c for c in candidates(e["sym"], e["date"], cm, side, spot) if c[1] == e["nxt"]]
        for v in VERSIONS:
            c = RS.pick(cands, v, e["date"], cm) if cands else None
            if c: out[(entry, v)] = (c[0], abs(c[3]))
    return out


def opt_path(e, contract, sec): return os.path.join(OUT, "opt", f"{e['date']}_{contract}_{sec}.csv.gz")


def fetch_opt(args):
    e, contract, sec = args
    p = opt_path(e, contract, sec)
    if os.path.exists(p): return
    m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", contract)
    if e["date"] >= SEC1:   # a cbbo-1s row stamped second s + 1 is the book as second s ended
        text = get("OPRA.PILLAR", "cbbo-1s", m.group(1).ljust(6) + m.group(2), e["date"], sec - 2, sec + LAG + 12)
        rows = [(sec_of(r["ts_recv"]) - 1, r["bid_px_00"], r["ask_px_00"]) for r in csv.DictReader(io.StringIO(text)) if r["bid_px_00"] and r["ask_px_00"]]
    else:                   # before it: every change of the best bid/ask; the last one in a second is that second's book
        text = get("OPRA.PILLAR", "cmbp-1", m.group(1).ljust(6) + m.group(2), e["date"], sec - 30, sec + LAG + 12)
        rows = [(sec_of(r["ts_recv"]), r["bid_px_00"], r["ask_px_00"]) for r in csv.DictReader(io.StringIO(text)) if r["bid_px_00"] and r["ask_px_00"]]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with gzip.open(p + ".tmp", "wt") as f: csv.writer(f).writerows(rows)
    os.replace(p + ".tmp", p)


def book_at(rows, s):
    k = [r for r in rows if r[0] <= s]
    return (float(k[-1][1]), float(k[-1][2])) if k else None


def trade(job):
    """One version's trade for one entry of one alert, or None."""
    e, entry, v, contract, delta, tg = job
    sec, side, spot = tg
    if entry == "close":
        q = RS.quote(contract, e["date"], sec // 60 - 1)
        if not q: return None
        buy = RS.fill(contract, e["date"], sec // 60 - 1, q); ct = sec // 60 - 1
    else:
        p = opt_path(e, contract, sec)
        if not os.path.exists(p): return None
        rows = [r for r in csv.reader(gzip.open(p, "rt"))]
        rows = [(int(a), b, c) for a, b, c in rows if float(b) > 0 and float(c) > 0]
        q = book_at(rows, sec + LAG)
        if not q: return None
        mid = (q[0] + q[1]) / 2; buy = mid + (q[1] - mid) / 2
        later = book_at(rows, sec + LAG + 10)
        if later and later[0] > buy: buy = min(later[1], buy * 1.1)
        ct = sec // 60
    w = LF.walk(e["sym"], e["date"], ct, side, contract, spot, e["u"])
    if not w: return None
    qs = RS.quote(contract, e["date"], w[3])
    if not qs: return None
    import strength_at
    st_m = ct if entry == "close" else ct - 1   # the last closed minute before the buy
    x = strength_at.of(e["sym"], e["date"]).get(st_m)
    t_side = d2_side = None
    if x: t_side, d2_side = (x[0], x[1]) if side == "C" else (-x[0], x[2])
    sign = 1 if side == "C" else -1
    bars = day(e["sym"], e["date"]); pb = day(e["sym"], CAL[CAL.index(e["date"]) - 1])
    mv_open = sign * (spot / bars[0][1] - 1) / e["u"] if bars and bars[0][0] <= 5 else None
    mv_close = sign * (spot / pb[-1][4] - 1) / e["u"] if pb else None
    return dict(entry=entry, v=v, date=e["date"], sym=e["sym"], minute=e["m"], buy=buy, sell=qs[0], ct=ct, bm=ct, xm=w[3], delta=delta,
                t=t_side, d2=d2_side, mv_open=mv_open, mv_close=mv_close)


def main():
    step = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    ev_file = os.path.join(OUT, f"events{TAG}.json")
    if step == "list":
        if os.environ.get("SEC_ALERT") == "fast": ev = fast_events()
        else:
            with mp.Pool(8) as pool: res = pool.map(events_of, TW.days(), chunksize=8)
            ev = [e for r in res for e in r]
        if os.environ.get("STR_TOP"):
            top = set(json.load(open(os.path.join(HERE, "strangle_top40.json")))[:int(os.environ["STR_TOP"])])
            if os.environ.get("STR_FAV"): top |= set(P["universe_fav"])   # and every favorite
            ev = [e for e in ev if e["sym"] in top]
        json.dump(ev, open(ev_file, "w")); print(len(ev), "alerts"); return
    ev = json.load(open(ev_file))
    if step == "stock":
        with ThreadPoolExecutor(40) as ex:
            for i, _ in enumerate(ex.map(fetch_stock, ev)):
                if i % 200 == 0: print(i, "/", len(ev), flush=True)
        return
    pk_file = os.path.join(OUT, f"picks{TAG}.json")
    if step == "pick":
        with mp.Pool(8) as pool: trig = pool.map(triggers, ev, chunksize=8)
        with mp.Pool(8) as pool: picks = pool.map(pick_for, list(zip(ev, trig)), chunksize=4)
        json.dump([dict(t=t, p={f"{k[0]}|{k[1]}": x for k, x in p.items()}) for t, p in zip(trig, picks)], open(pk_file, "w"))
        print(sum(len(p) for p in picks), "picks"); return
    pk = json.load(open(pk_file))
    if step == "option":
        jobs = sorted({(i, x[0], pk[i]["t"][k.split("|")[0]][0]) for i in range(len(ev)) for k, x in pk[i]["p"].items() if not k.startswith("close")})
        with ThreadPoolExecutor(40) as ex:
            for n, _ in enumerate(ex.map(lambda j: fetch_opt((ev[j[0]], j[1], j[2])), jobs)):
                if n % 200 == 0: print(n, "/", len(jobs), flush=True)
        return
    if step == "run":
        import news_filter as nf
        top = set(json.load(open(os.path.join(HERE, "strangle_top40.json")))[:int(os.environ.get("STR_TOP", "999"))]) if os.environ.get("STR_TOP") else None
        jobs = [(ev[i], k.split("|")[0], k.split("|")[1], x[0], x[1], pk[i]["t"][k.split("|")[0]]) for i in range(len(ev)) for k, x in pk[i]["p"].items() if (top is None or ev[i]["sym"] in top) and ev[i]["sym"] not in os.environ.get("STR_EXCL", "").split(",")]
        with mp.Pool(8) as pool: T = [t for t in pool.map(trade, jobs, chunksize=8) if t]
        rows = [dict(date=d, sym=s, minute=0, right="C") for d, s in {(t["date"], t["sym"]) for t in T}]
        nf.features(rows)
        skip = {(r["date"], r["sym"]) for r in rows if r["e_next"] == 0 or (r["pre_rvol"] is not None and r["pre_rvol"] >= 4)}
        spans = (("12 months", "2025-10-23", "9999"), ("6 months", "2026-04-23", "9999"))
        if TAG: spans = ((f"3 years ({FROM} on)", FROM, "9999"), ("2024", "2024", "2025"), ("2025", "2025", "2026"), ("2026", "2026", "9999")) + spans
        FILTERS = {"all": lambda t: True}
        if os.environ.get("STR_FILTERS"):
            ok = lambda t, k: t[k] is not None
            FILTERS.update({
                "t >= 0 (agrees)": lambda t: ok(t, "t") and t["t"] >= 0,
                "t >= 1.2": lambda t: ok(t, "t") and t["t"] >= 1.2,
                "t >= 1.8": lambda t: ok(t, "t") and t["t"] >= 1.8,
                "D2 >= 1.0": lambda t: ok(t, "d2") and t["d2"] >= 1.0,
                "D2 >= 1.5": lambda t: ok(t, "d2") and t["d2"] >= 1.5,
                "t >= 1.2 and D2 >= 1.5": lambda t: ok(t, "t") and ok(t, "d2") and t["t"] >= 1.2 and t["d2"] >= 1.5,
                "t >= 1.8, or t >= 1.2 and D2 >= 1.5 (Main bot 2.6)": lambda t: ok(t, "t") and (t["t"] >= 1.8 or (t["t"] >= 1.2 and ok(t, "d2") and t["d2"] >= 1.5)),
                "t < 0 (disagrees)": lambda t: ok(t, "t") and t["t"] < 0,
            })
            if os.environ.get("STR_FILTERS") == "move":
                FILTERS = {"all": lambda t: True, "t >= 0": lambda t: ok(t, "t") and t["t"] >= 0}
                for k in (2, 3, 4, 6):
                    FILTERS[f"skip open move >= {k}"] = (lambda k: lambda t: ok(t, "mv_open") and t["mv_open"] < k)(k)
                    FILTERS[f"skip day move >= {k}"] = (lambda k: lambda t: ok(t, "mv_close") and t["mv_close"] < k)(k)
                for k in (2, 3, 4, 6):
                    FILTERS[f"t >= 0, skip open move >= {k}"] = (lambda k: lambda t: ok(t, "t") and t["t"] >= 0 and ok(t, "mv_open") and t["mv_open"] < k)(k)
                    FILTERS[f"t >= 0, skip day move >= {k}"] = (lambda k: lambda t: ok(t, "t") and t["t"] >= 0 and ok(t, "mv_close") and t["mv_close"] < k)(k)
            VERS, ENTS = ("plain20",), ("cross",)
            if os.environ.get("STR_FILTERS") != "move": VERS, ENTS = ("plain20",), ("close", "cross")
        else: VERS, ENTS = VERSIONS, ENTRIES
        GROUPS = {"": lambda t: True}
        if os.environ.get("STR_GROUPS"):
            t15 = set(json.load(open(os.path.join(HERE, "strangle_top40.json")))[:15])
            GROUPS = {"all: ": lambda t: True, "top 15: ": lambda t: t["sym"] in t15, "the rest: ": lambda t: t["sym"] not in t15}
        for lab, lo, hi in spans:
            print(f"\n### {lab}\n\n| Filter | Version | Entry | Trades | Avg per trade | End ($100K), worst drop |\n|---|---|---|---|---|---|")
            for gname, in_group in GROUPS.items():
             for fname0, keep_if0 in FILTERS.items():
              fname = gname + fname0
              keep_if = (lambda a, b: lambda t: a(t) and b(t))(in_group, keep_if0)
              for v in VERS:
                for entry in ENTS:
                    S = [t for t in T if t["v"] == v and t["entry"] == entry and lo <= t["date"] < hi and (t["date"], t["sym"]) not in skip and keep_if(t)]
                    by = {}
                    for t in S: by.setdefault((t["date"], t["sym"]), []).append(dict(minute=t["minute"], trade=t))
                    keep = []
                    for k, evs in by.items():
                        for x in TW.pick(dict(events=sorted(evs, key=lambda z: z["minute"])), "flat")[:2]: keep.append(x["trade"])
                    eL, dL, R, _, _ = D.account(keep, 1, 2, loss=7.5, max_trades=15, max_open=5)
                    avg = sum((r["sell"] * 100 - 0.62) / (r["buy"] * 100 + 0.62) - 1 for r in R) / max(1, len(R))
                    if os.environ.get("STR_DETAIL") and v == "plain20" and entry == "cross" and lab == "12 months":
                        import collections
                        by_s = collections.defaultdict(list)
                        for r in R: by_s[r["sym"]].append(r["pnl"])
                        for sy, ps in sorted(by_s.items(), key=lambda x: -len(x[1])): print(f"  {sy}: {len(ps)} trades, {sum(p > 0 for p in ps)} won, ${sum(ps):,.0f}")
                        print("  months:", dict(sorted(collections.Counter(r["date"][:7] for r in R).items())))
                    print(f"| {fname} | {v} | {entry} | {len(R)} | {100 * avg:+.1f}% | ${eL:,.0f}, {100 * dL:.1f}% |", flush=True)


if __name__ == "__main__": main()
