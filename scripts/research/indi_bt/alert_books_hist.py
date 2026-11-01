"""The option books around every Volume bot alert, bought from Databento for the past (the user, 2026-10-31: "I want to
start to save the needed data for alerts from this bot" ... "i want to save every 2 second around the alert + delta 0.1
to 0.35" ... "go with the second one, and for last 3 months"). The live trader saves the same from now on
(apps/trader/src/alert-books.ts); this fills 2026-08-03 -> 2026-10-30 so one backtest reader can use both.

Alerts: the Volume bot's plan alerts (the 1-minute volume alert as the live bot fires it, 09:40-12:59) and shock alerts
(60-second at 15x, 09:40-15:30, from data/local/bars-10s.sqlite, f60_alerts.py) on the 69 Favorites; F60x2 is not in use. Contracts: the alerted stock's options with |delta| 0.10-0.35, calls and
puts, on the bot's expiry (the nearest within 4 days: 0DTE, else 1DTE, else 2-4 DTE), delta from Black-Scholes at the
alert price with the stock's 20-day volatility x 1.15 (Alpaca contract list + daily bars, free).
  entry: OPRA cbbo-1s from the alert second - 2 s to + 300 s, one request per alert;
  exit:  OPRA cbbo-1m from the first alert minute of the stock-day to 15:30 New York, the union of that day's contracts.
Cost cap: `cost` sums metadata.get_cost over the exact request list; `fetch` refuses when it is over CAP (default $20).

  node --env-file=.env <dir>/run.mjs alert_books_hist.py alerts|list|cost|fetch|store|upload   (from the app repo root)

Writes (all under data/local, not Git):
  x/alertbooks/alerts_{plan,shock}.json   the alerts
  x/alertbooks/requests.csv               the request list (kind, symbol, date, second, expiry, start, end, contracts, deltas, cost)
  x/alertbooks/1s/, 1m/                   the raw Databento CSVs (resumable: a file present is not fetched again)
  alert-books.sqlite                      alert_books_hist (shaped like the live AlertBookWatch: samples {at, books}) and
                                          minute_books ([[m, bid, ask], ...], m = the session minute whose CLOSE the book is)
  dbx_cache/alertbooks/<date>.csv.gz      the minute books in dbx_fetch.py's cache format, for quotes_upload.py ("databento")
"""
import base64, collections, csv, datetime as dt, gzip, io, json, math, os, sqlite3, statistics as st, subprocess, sys, time
import urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
FROM, TO = os.environ.get("AB_FROM", "2026-08-03"), os.environ.get("AB_TO", "2026-10-30")
CAP = float(os.environ.get("AB_CAP", 20))
DIR = "data/local/x/alertbooks"
DB = "data/local/alert-books.sqlite"
CACHE = os.path.join(HERE, "dbx_cache", "alertbooks")   # quotes_upload.py reads dbx_cache/**
HEAD = ["contract", "minute", "bid", "ask", "bid_sz", "ask_sz"]
DELTA = (0.10, 0.35)
FINE_S, STEP_S, LAST_MIN = 300, 2, 360
PLAN_FIRST, PLAN_LAST = 10, 209   # the plan alert window (strangle settings firstMinute, lastMinute)   # the entry window, its sample step, 15:30 = session minute 360
FAV = ("AAOI,AAPL,ADBE,AMBA,AMD,AMZN,ARM,ASTS,AVGO,BA,BABA,CBRS,COIN,CRDO,CRM,CRWD,CRWV,CSCO,CVX,DELL,F,GLD,GOOGL,HIMS,"
       "HOOD,IBIT,IBKR,IBM,IGV,INTC,IONQ,IREN,IWM,LITE,LLY,LMND,META,MRNA,MRVL,MSFT,MSTR,MU,NBIS,NOW,NU,NVDA,OKLO,ONDS,ORCL,"
       "PANW,PLTR,QBTS,QCOM,RKLB,SHOP,SIRI,SKHY,SMCI,SNDK,SNOW,SOFI,SOXX,SPCX,TSEM,TSLA,UAL,UBER,WMT,XYZ")


def dbx_auth():
    return "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()


def alpaca(url):
    req = urllib.request.Request(url, headers={"APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
                                               "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET"]})
    for tries in range(8):   # 429 (too many requests) and busy moments: wait longer each time
        try: return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500 or tries == 7: raise
        except (urllib.error.URLError, TimeoutError):
            if tries == 7: raise
        time.sleep(5 * (tries + 1))


def dbx(path, **q):
    data = urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", stype_in="raw_symbol", **q)).encode()
    req = urllib.request.Request(f"https://hist.databento.com/v0/{path}", data=data, headers={"Authorization": dbx_auth()})
    for tries in range(6):   # a busy server: wait and ask again
        try: return urllib.request.urlopen(req, timeout=900).read().decode()
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429: raise
            if tries == 5: raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if tries == 5: raise
        time.sleep(15 * (tries + 1))


def pad(s):
    """OCC: the root, then 15 characters (yymmdd, C/P, the strike x 1000)."""
    return s[:-15].ljust(6) + s[-15:]


def at(date, second):
    return dt.datetime.fromisoformat(date + "T09:30").replace(tzinfo=NY) + dt.timedelta(seconds=second)


def iso(t): return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")


# ---- 1. alerts ----

def minute_bars(sym, date):
    """[[m, o, h, l, c, v], ...] of the regular session: the research store, else Alpaca's 1-minute SIP bars (free)."""
    import store
    got = store.day(sym, date)
    if got: return got
    p = f"{DIR}/minutes/{sym}_{date}.json"
    if os.path.exists(p): return json.load(open(p))
    r = alpaca("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(dict(
        symbols=sym, timeframe="1Min", start=iso(at(date, 0)) + "Z", end=iso(at(date, 390 * 60)) + "Z", feed="sip",
        limit=10000)))
    out = []
    for b in (r.get("bars") or {}).get(sym, []):
        t = dt.datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(NY)
        m = t.hour * 60 + t.minute - 570
        if 0 <= m < 390: out.append([m, b["o"], b["h"], b["l"], b["c"], b["v"]])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(out, open(p, "w"))
    return out


def plan_sides(sym, cal, i):
    """The alert side ('up' / 'down' / None) at each minute of cal[i], against the 20 sessions before."""
    from rvol_alert import alerts as rv_alerts, windows as rv_windows
    return rv_alerts(minute_bars(sym, cal[i]), [rv_windows(minute_bars(sym, d))[0] for d in cal[i - 20:i]])


def plan_alerts(sym, cal):
    """The Volume bot's plan alerts as the live bot fires them (apps/trader/src/strangle.ts entries()): alerts() on
    1-minute bars against the 20 prior sessions' windows; a fresh burst at m = an alert at m and none at m - 1, the
    day's first alert counted from firstMinute (10) even when m - 1 had one; up to lastMinute (209). Every alert is
    kept (the live bot also skips a stock while it is busy or done for the day; the books are saved regardless)."""
    from rvol_alert import alerts as rv_alerts, windows as rv_windows
    win = {}
    def w(d):
        if d not in win: win[d] = rv_windows(minute_bars(sym, d))[0]
        return win[d]
    out = []
    for i, date in enumerate(cal):
        if not FROM <= date <= TO or i < 20: continue
        bars = minute_bars(sym, date)
        if not bars: continue
        sides = rv_alerts(bars, [w(d) for d in cal[i - 20:i]])
        first = next((m for m in range(PLAN_FIRST, PLAN_LAST + 1) if sides[m]), None)
        by = {b[0]: b for b in bars}
        for m in range(PLAN_FIRST, PLAN_LAST + 1):
            if not sides[m]: continue
            if m != first and sides[m - 1]: continue
            out.append(dict(sym=sym, date=date, minute=m, sec=(m + 1) * 60, price=by[m][4], side=sides[m]))
    return out


def trading_days():
    """The 10-second database's trading days (it runs through TO)."""
    db = sqlite3.connect("file:data/local/bars-10s.sqlite?mode=ro", uri=True)
    return [r[0] for r in db.execute("SELECT DISTINCT date FROM symbol_days WHERE symbol = 'NVDA' ORDER BY date")]


def alerts():
    """Plan alerts (1-minute) and shock alerts (60-second at 15x, 09:40-15:30); F60x2 is not in use (the user,
    2026-10-31: "F60x2 is currently not in use. only plan and shock is relevant")."""
    os.makedirs(DIR, exist_ok=True)
    cal = trading_days()
    from concurrent.futures import ProcessPoolExecutor   # the research store's SQLite stays in one thread per process
    syms = FAV.split(",")
    with ProcessPoolExecutor(6) as ex:
        plan = [a for got in ex.map(plan_alerts, syms, [cal] * len(syms)) for a in got]
    json.dump(plan, open(f"{DIR}/alerts_plan.json", "w"))
    print(len(plan), "plan alerts on", len({(a["sym"], a["date"]) for a in plan}), "stock-days")
    f60 = os.path.join(HERE, "f60_alerts.py")
    subprocess.run([sys.executable, f60, f"{DIR}/alerts_shock.json", FROM, TO, FAV], check=True,
                   env={**os.environ, "F60_K": "15", "F60_LAST": "2159"})


def check_plan():
    """Dumps two stock-days' bars and windows for the TypeScript check (scratch: plan_check.ts)."""
    cal = trading_days()
    from rvol_alert import windows as rv_windows
    out = []
    for sym, date in (("NVDA", "2026-10-28"), ("COIN", "2026-09-03")):
        i = cal.index(date)
        out.append(dict(sym=sym, date=date, bars=minute_bars(sym, date),
                        hist=[rv_windows(minute_bars(sym, d))[0] for d in cal[i - 20:i]], py=plan_sides(sym, cal, i)))
    json.dump(out, open(f"{DIR}/plan_check.json", "w"))
    print("wrote", f"{DIR}/plan_check.json")


# ---- 2. the request list ----

def chain(sym, date):
    """Contracts expiring within 4 days of date (expired and still listed)."""
    d0 = dt.date.fromisoformat(date)
    out = {}
    for status in ("inactive", "active"):
        token = None
        while True:
            q = dict(underlying_symbols=sym, status=status, expiration_date_gte=date,
                     expiration_date_lte=str(d0 + dt.timedelta(days=4)), limit=10000)
            if token: q["page_token"] = token
            r = alpaca("https://paper-api.alpaca.markets/v2/options/contracts?" + urllib.parse.urlencode(q))
            for c in r.get("option_contracts") or []:
                if c.get("underlying_symbol", sym) == sym: out[c["symbol"]] = c
            token = r.get("next_page_token")
            if not token: break
    return list(out.values())


def vol(sym, date):
    end = dt.date.fromisoformat(date)
    r = alpaca("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(dict(
        symbols=sym, timeframe="1Day", start=str(end - dt.timedelta(days=45)), end=str(end - dt.timedelta(days=1)),
        adjustment="split", feed="sip", limit=1000)))
    c = [b["c"] for b in (r.get("bars") or {}).get(sym, [])][-21:]
    rets = [math.log(b / a) for a, b in zip(c, c[1:]) if a > 0 and b > 0]
    return max(0.15, st.pstdev(rets) * math.sqrt(252) * 1.15) if len(rets) > 5 else 0.5


def bs_delta(S, K, T, s, call):
    d1 = (math.log(S / K) + 0.5 * s * s * T) / (s * math.sqrt(T))
    n = 0.5 * (1 + math.erf(d1 / math.sqrt(2)))
    return n if call else n - 1


def chain_vol(sym, date):
    """The chain and the volatility of a stock-day, kept on disk so a rerun does not ask Alpaca again."""
    p = f"{DIR}/chains/{sym}_{date}.json"
    if os.path.exists(p): return json.load(open(p))
    got = [chain(sym, date), vol(sym, date)]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(got, open(p + ".tmp", "w")); os.replace(p + ".tmp", p)
    return got


def stock_day(key, alerts_of):
    sym, date = key
    cs, s = chain_vol(sym, date)
    exps = sorted({c["expiration_date"] for c in cs if c["symbol"][:-15] == sym})
    if not exps: return [], f"{sym} {date}: no expiry within 4 days"
    exp = exps[0]
    close = dt.datetime.fromisoformat(exp + "T16:00").replace(tzinfo=NY)
    rows, union = [], {}
    for kind, a in alerts_of:
        t0 = at(date, a["sec"])
        T = max((close - t0).total_seconds(), 1800) / (365 * 86400)
        band = []
        for c in cs:
            # the stock's own contracts only: an adjusted series (BABA2 ...) is not what the bot buys
            if c["expiration_date"] != exp or c["symbol"][:-15] != sym: continue
            d = bs_delta(a["price"], float(c["strike_price"]), T, s, c["type"] == "call")
            if DELTA[0] <= abs(d) <= DELTA[1]: band.append((c["symbol"], round(d, 3)))
        band.sort()
        if not band: continue
        for sym_, d in band: union.setdefault(sym_, d)
        rows.append(dict(kind=kind, symbol=sym, date=date, second=a["sec"], expiry=exp,
                         start=iso(t0 - dt.timedelta(seconds=2)), end=iso(t0 + dt.timedelta(seconds=FINE_S + 1)),
                         contracts=";".join(x for x, _ in band), deltas=";".join(str(d) for _, d in band), cost=""))
    if union:
        first = min(a["sec"] for _, a in alerts_of)
        m0 = first // 60
        rows.append(dict(kind="minute", symbol=sym, date=date, second=first, expiry=exp,
                         start=iso(at(date, (m0 - 1) * 60)), end=iso(at(date, (LAST_MIN + 2) * 60)),
                         contracts=";".join(sorted(union)), deltas=";".join(str(union[x]) for x in sorted(union)), cost=""))
    return rows, None


def build_list():
    by = collections.defaultdict(list)
    for kind in ("plan", "shock"):
        for a in json.load(open(f"{DIR}/alerts_{kind}.json")):
            if FROM <= a["date"] <= TO: by[(a["sym"], a["date"])].append((kind, a))
    rows, gaps = [], []
    with ThreadPoolExecutor(4) as ex:
        for k, (r, gap) in zip(sorted(by), ex.map(lambda k: stock_day(k, sorted(by[k], key=lambda x: x[1]["sec"])), sorted(by))):
            rows += r
            if gap: gaps.append(gap)
    write_list(rows)
    n_al = sum(len(v) for v in by.values())
    print(f"{n_al} alerts on {len(by)} stock-days -> {sum(r['kind'] != 'minute' for r in rows)} entry requests, "
          f"{sum(r['kind'] == 'minute' for r in rows)} minute requests; {len(gaps)} stock-days without an expiry")
    for g in gaps[:20]: print("  gap:", g)
    json.dump(gaps, open(f"{DIR}/gaps.json", "w"))


def write_list(rows):
    with open(f"{DIR}/requests.csv.tmp", "w", newline="") as f:
        w = csv.DictWriter(f, ["kind", "symbol", "date", "second", "expiry", "start", "end", "contracts", "deltas", "cost"])
        w.writeheader(); w.writerows(rows)
    os.replace(f"{DIR}/requests.csv.tmp", f"{DIR}/requests.csv")


def read_list():
    return list(csv.DictReader(open(f"{DIR}/requests.csv")))


def schema(r): return "cbbo-1m" if r["kind"] == "minute" else "cbbo-1s"


# ---- 3. the cost (free) ----

def cost():
    rows = read_list()
    todo = [r for r in rows if r["cost"] == ""]
    def one(r):
        syms = [pad(x) for x in r["contracts"].split(";")]
        try:
            return float(dbx("metadata.get_cost", schema=schema(r), symbols=",".join(syms), start=r["start"], end=r["end"]))
        except urllib.error.HTTPError as e:   # 422: Databento knows none of the symbols; a gap, not a stop
            if e.code != 422: raise
            r["contracts"] = ""
            return 0.0
    with ThreadPoolExecutor(8) as ex:
        for i, (r, c) in enumerate(zip(todo, ex.map(one, todo))):
            r["cost"] = f"{c:.6f}"
            if i % 500 == 499: write_list(rows); print(f"  {i + 1}/{len(todo)} priced", flush=True)
    write_list(rows)
    tot = collections.defaultdict(float)
    for r in rows: tot[(r["kind"], schema(r))] += float(r["cost"])
    for k, v in sorted(tot.items()): print(f"  {k[0]:6} {k[1]}: ${v:.2f}")
    total = sum(tot.values())
    gaps = [f"{r['kind']} {r['symbol']} {r['date']} {r['second']}" for r in rows if not r["contracts"]]
    print(f"TOTAL get_cost ${total:.2f} for {len(rows) - len(gaps)} requests (cap ${CAP:.0f}); "
          f"{len(gaps)} requests Databento could not resolve: {gaps[:10]}")
    return total


# ---- 4. the download ----

def raw_path(r):
    if r["kind"] == "minute": return f"{DIR}/1m/{r['date']}_{r['symbol']}.csv.gz"
    return f"{DIR}/1s/{r['date']}_{r['symbol']}_{r['second']}_{r['kind']}.csv.gz"


def fetch():
    rows = read_list()
    if any(r["cost"] == "" for r in rows): sys.exit("price the list first (cost)")
    total = sum(float(r["cost"]) for r in rows)
    if total > CAP: sys.exit(f"STOP: the list costs ${total:.2f}, over the ${CAP:.0f} cap; nothing downloaded")
    todo = [r for r in rows if r["contracts"] and not os.path.exists(raw_path(r))]
    print(f"list ${total:.2f}; {len(rows) - len(todo)} done, {len(todo)} to fetch", flush=True)
    def one(r):
        text = dbx("timeseries.get_range", schema=schema(r), encoding="csv", pretty_px="true", pretty_ts="true",
                   map_symbols="true", symbols=",".join(pad(x) for x in r["contracts"].split(";")),
                   start=r["start"], end=r["end"])
        p = raw_path(r)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with gzip.open(p + ".tmp", "wt") as f: f.write(text)
        os.replace(p + ".tmp", p)
        return text.count("\n") - 1
    failed, n = [], 0
    with ThreadPoolExecutor(6) as ex:
        futs = [(r, ex.submit(one, r)) for r in todo]
        for i, (r, f) in enumerate(futs):
            try: n += f.result()
            except Exception as e: failed.append(f"{r['kind']} {r['symbol']} {r['date']} {r['second']}: {e}")
            if i % 250 == 249: print(f"  {i + 1}/{len(todo)} fetched, {n:,} rows", flush=True)
    print(f"fetched {len(todo) - len(failed)} files, {n:,} rows; {len(failed)} failed")
    for x in failed[:20]: print("  failed:", x)
    json.dump(failed, open(f"{DIR}/fetch_failed.json", "w"))


# ---- 5. the local store ----

def pack(obj):
    return "gz:" + base64.b64encode(gzip.compress(json.dumps(obj, separators=(",", ":")).encode(), mtime=0)).decode()


def quotes_of(path):
    """{contract: [(ts_ms, bid, ask), ...]} oldest first."""
    out = collections.defaultdict(list)
    for r in csv.DictReader(io.StringIO(gzip.open(path, "rt").read())):
        if not r.get("bid_px_00") or not r.get("ask_px_00"): continue
        t = dt.datetime.fromisoformat(r["ts_recv"].replace("Z", "+00:00"))
        out[r["symbol"].replace(" ", "")].append((int(t.timestamp() * 1000), float(r["bid_px_00"]), float(r["ask_px_00"])))
    for v in out.values(): v.sort()
    return out


def store():
    rows = read_list()
    db = sqlite3.connect(DB)
    db.executescript("""
      CREATE TABLE IF NOT EXISTS alert_books_hist (day TEXT NOT NULL, symbol TEXT NOT NULL, second INTEGER NOT NULL,
        kind TEXT NOT NULL, expiry TEXT NOT NULL, contracts TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (day, symbol, second, kind));
      CREATE TABLE IF NOT EXISTS minute_books (contract TEXT NOT NULL, date TEXT NOT NULL, quotes TEXT NOT NULL,
        PRIMARY KEY (contract, date));""")
    n_al = n_min = 0
    by_date = collections.defaultdict(list)   # dbx_cache rows for quotes_upload.py
    for r in rows:
        p = raw_path(r)
        # alert_books_topup.py's downloads (topup: the strikes the first band missed; topup_year: the year, 54 stocks; topup_shock4: SLV TQQQ SOXL SMH since 2024)
        tops = [p.replace(f"{DIR}/", f"{DIR}/{t}/", 1) for t in ("topup", "topup_year", "topup_shock4")]
        tops = [t for t in tops if os.path.exists(t)]
        if not os.path.exists(p) and not tops: continue
        q = quotes_of(p) if os.path.exists(p) else collections.defaultdict(list)
        for top in tops:
            for c, qs in quotes_of(top).items(): q[c] = sorted(q.get(c, []) + qs)
        cons = r["contracts"].split(";")
        if r["kind"] != "minute":
            # every 2 s from the alert second: the book in force at that moment (the last quote at or before it)
            t0 = int(at(r["date"], int(r["second"])).timestamp() * 1000)
            samples = []
            idx = {c: 0 for c in cons}
            for k in range(0, FINE_S + 1, STEP_S):
                t = t0 + k * 1000
                books = []
                for c in cons:
                    qs, i = q.get(c, []), idx[c]
                    while i < len(qs) and qs[i][0] <= t: i += 1
                    idx[c] = i
                    books.append([qs[i - 1][1], qs[i - 1][2]] if i else None)
                samples.append({"at": t, "books": books})
            contracts = [{"symbol": c, "delta": float(d)} for c, d in zip(cons, r["deltas"].split(";"))]
            db.execute("INSERT OR REPLACE INTO alert_books_hist VALUES (?,?,?,?,?,?,?)",
                       (r["date"], r["symbol"], int(r["second"]), r["kind"], r["expiry"],
                        json.dumps(contracts), pack(samples)))
            n_al += 1
        else:
            for c, qs in q.items():
                mins = {}
                for ts, bid, ask in qs:
                    t = dt.datetime.fromtimestamp(ts / 1000, NY)
                    began = t.hour * 60 + t.minute - 570   # the row stamped at minute m's start = the book as m began
                    by_date[r["date"]].append((c, began, bid, ask, "", ""))
                    m = began - 1                          # = the book as minute m - 1 closed
                    if 0 <= m <= LAST_MIN and ask > 0 and 0 <= bid <= ask: mins[m] = [m, round(bid, 4), round(ask, 4)]
                if mins:
                    db.execute("INSERT OR REPLACE INTO minute_books VALUES (?,?,?)",
                               (c, r["date"], pack([mins[m] for m in sorted(mins)])))
                    n_min += 1
    db.commit()
    os.makedirs(CACHE, exist_ok=True)
    for date, rs in by_date.items():
        path = os.path.join(CACHE, f"{date}.csv.gz")
        with gzip.open(path + ".tmp", "wt") as f:
            w = csv.writer(f); w.writerow(HEAD); w.writerows(sorted(set(rs)))
        os.replace(path + ".tmp", path)
    print(f"stored {n_al} alert windows and {n_min} contract-days of minute books in {DB}; "
          f"{len(by_date)} dates written to {CACHE} for quotes_upload.py")


def upload():
    subprocess.run([sys.executable, os.path.join(HERE, "quotes_upload.py")] + sys.argv[2:], check=True)


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else ""
    {"alerts": alerts, "check_plan": check_plan, "list": build_list, "cost": cost, "fetch": fetch, "store": store, "upload": upload}[step]()
