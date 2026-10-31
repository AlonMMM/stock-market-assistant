"""The champion (2.7 at minute fills) on REAL option data before 2024 (the user, 2026-10-31: "yes, download it", and
"extract only the stock list he used to trade in 2021-2022-2023 ... these are the hot stock"). Databento OPRA.PILLAR:
  definition  the listed contracts of each signal stock-day (parent SYM.OPT) -> expiries and strikes
  ohlcv-1m    the option minute bars (the picker's price, the 30-minute volume floor, the simulator's bar walk)
  cbbo-1m     the best bid / ask each minute (the real fills, as real_bench.py / opt_spread.py on 2024-26)
  statistics  open interest
The list of a year = the stocks and ETFs Indi traded THAT year (his main account; index options left out): the hot names
of the time, chosen with that year's knowledge. Stages (each resumable; files under data/local/x/bt/y<year>/):
  signals   defence_signals.py on the list: main c12_15, adds base; the news filter where its data exists
  defs      the definitions of every signal stock-day
  cands     pass A: every signal's candidate strikes (1-7 day expiry, OTM within 20%, the 16 nearest the money)
  cost      Databento's own price of pass A (free metadata call per day); stops above MAX_USD
  fetchA    pass A: ohlcv-1m, cbbo-1m, statistics for the signal days
  pick      the champion's pick on the real bars -> pass B: the picked contracts on the later days to expiry
  fetchB    pass B
  run       the walks (the champion's exits on the real bars, fills on the real quotes) and the tables
  node --env-file=.env <dir>/run.mjs dbx22.py <year> <stage>...      (from the app repo root)
"""
import base64, collections, csv, datetime as dt, gzip, io, json, multiprocessing as mp, os, re, statistics as st, sys, time
import urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ["BT_RULES"] = "c12_15,base"
import defence_signals as DS
import sim
import cheap_up as cu
import store
import floor_exception as fe
import news_filter as nf
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from score_sum import account

YEAR = sys.argv[1]
STAGES = sys.argv[2:]
NY = ZoneInfo("America/New_York")
B = "data/local/x/bt"
D = f"{B}/y{YEAR}"
QDIR = os.path.join(D, "quotes")
os.makedirs(os.path.join(QDIR, "oi"), exist_ok=True); os.makedirs(os.path.join(D, "defs"), exist_ok=True)
MAX_USD = float(os.environ.get("MAX_USD", 100))
SKIP = {"SPXW", "SPX", "NDXP", "VIXW"}
CAL = store.calendar(); IDX = {d: i for i, d in enumerate(CAL)}
LIST = sorted({r["contract"].split()[0] for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{YEAR}/actions.csv"))
               if r["account"] == "silexx" and r["action"] == "open"} - SKIP) if os.path.exists(f"data/local/x/ultrawavetrader-{YEAR}/actions.csv") \
    else json.load(open(os.environ["LIST_FILE"]))
DS.SPAN = {YEAR: (f"{YEAR}-01-03", f"{YEAR}-12-29")}
AUTH = "Basic " + base64.b64encode((os.environ.get("DATABENTO_API_KEY", "") + ":").encode()).decode()
OCCRE = re.compile(r"^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")


# ---- Databento ----
def pad(s):
    m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", s)
    return m.group(1).ljust(6) + m.group(2)


def utc(date, minute):
    h, m = divmod(570 + minute, 60)
    return dt.datetime.fromisoformat(f"{date}T{h:02d}:{m:02d}").replace(tzinfo=NY).astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M")


def api(path, **q):
    data = urllib.parse.urlencode(q).encode()
    req = urllib.request.Request(f"https://hist.databento.com/v0/{path}", data=data, headers={"Authorization": AUTH})
    for tries in range(6):
        try: return urllib.request.urlopen(req, timeout=900).read().decode()
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429: raise RuntimeError(f"{e.code} {e.read().decode()[:300]}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e: pass
        time.sleep(15 * (tries + 1))
    raise RuntimeError("Databento keeps failing")


def rows(schema, syms, start, end, stype="raw_symbol"):
    out = []
    for i in range(0, len(syms), 2000):
        part = syms[i:i + 2000]
        text = api("timeseries.get_range", dataset="OPRA.PILLAR", schema=schema, stype_in=stype, encoding="csv", pretty_px="true",
                   pretty_ts="true", map_symbols="true", symbols=",".join(part if stype == "parent" else [pad(s) for s in part]), start=start, end=end)
        out += list(csv.DictReader(io.StringIO(text)))
    return out


def nymin(ts):
    t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(NY)
    return t.hour * 60 + t.minute - 570


# ---- local option store ----
odb = __import__("sqlite3").connect(os.path.join(D, "options.sqlite"), timeout=120)
odb.execute("CREATE TABLE IF NOT EXISTS bars (symbol TEXT, date TEXT, bars TEXT, PRIMARY KEY (symbol, date))")
odb.execute("CREATE TABLE IF NOT EXISTS done (key TEXT PRIMARY KEY)")
_ob, _defs = {}, {}


def defs(und, date):
    k = (und, date)
    if k not in _defs:
        p = os.path.join(D, "defs", f"{und}_{date}.json")
        _defs[k] = json.load(open(p)) if os.path.exists(p) else None
    return _defs[k]


def opt_day(sym, date):
    k = (sym, date)
    if k not in _ob:
        if len(_ob) > 20000: _ob.clear()
        r = odb.execute("SELECT bars FROM bars WHERE symbol=? AND date=?", k).fetchone()
        _ob[k] = json.loads(r[0]) if r else []
    return _ob[k]


_orig_day = store.day


def day(sym, date):
    return opt_day(sym, date) if OCCRE.match(sym) else _orig_day(sym, date)


def expiries(und, start, end):
    ex = set()
    for f in os.listdir(os.path.join(D, "defs")):
        if f.startswith(und + "_"):
            x = defs(und, f[len(und) + 1:-5])
            if x: ex.update(x["exp"])
    return sorted(e for e in ex if start <= e <= end)


def chain(und, expiry, right):
    ks = set()
    for f in os.listdir(os.path.join(D, "defs")):
        if f.startswith(und + "_"):
            x = defs(und, f[len(und) + 1:-5])
            if x: ks.update(x["k"].get(f"{expiry}|{right}", []))
    return sorted(ks)


for mod in (sim, cu): mod.day = day
sim.chain, sim.expiries, sim.fetch_bars = chain, expiries, (lambda *a, **k: None)
RB.DBX = QDIR; RB.Q.clear(); RB.OI.clear()


# ---- stages ----
def sig_one(sym):
    o = DS.stock(sym)
    return [dict(r, kind="main") for r in o["c12_15"]] + [dict(r, kind="add") for r in o["base"]]


def stage_signals():
    with mp.Pool(8) as pool: S = [r for part in pool.map(sig_one, LIST) for r in part]
    nf.features(S)
    for r in S: r["news_ok"] = int(r["e_next"] != 0 and (r["pre_rvol"] is None or r["pre_rvol"] < 4))
    json.dump(S, open(os.path.join(D, "signals.json"), "w"))
    print(len(S), "signals on", len(LIST), "stocks:", dict(collections.Counter(r["kind"] for r in S)), flush=True)


def signals(): return json.load(open(os.path.join(D, "signals.json")))


def one_def(job):
    und, date = job
    p = os.path.join(D, "defs", f"{und}_{date}.json")
    if os.path.exists(p): return 0
    # OPRA publishes the day's definitions at the open (13:30 / 14:30 UTC): ask for the whole day
    nxt = (dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat()
    try: R = rows("definition", [f"{und}.OPT"], f"{date}T00:00", f"{nxt}T00:00", stype="parent")
    except RuntimeError as e:
        if "symbology" not in str(e): raise
        R = []   # no options listed for this name (e.g. GNS): an empty chain, so its signals find no contract
    ex, ks = set(), collections.defaultdict(set)
    for r in R:
        e = r.get("expiration", "")[:10]; c = r.get("instrument_class"); k = r.get("strike_price")
        if not e or c not in ("C", "P") or not k: continue
        ex.add(e); ks[f"{e}|{c}"].add(round(float(k), 3))
    json.dump({"exp": sorted(ex), "k": {a: sorted(b) for a, b in ks.items()}}, open(p, "w"))
    return len(R)


def stage_defs():
    jobs = sorted({(r["sym"], r["date"]) for r in signals()})
    with ThreadPoolExecutor(8) as ex:
        for i, n in enumerate(ex.map(one_def, jobs)):
            if i % 200 == 0: print(f"defs {i}/{len(jobs)}", flush=True)
    print("defs done", len(jobs), flush=True)


def cands_of(t):
    m = int(t["minute"]); spot = float(t["price"]); call = t["right"] == "C"
    exp = sim.expiry_for(t["sym"], t["date"])
    if not exp: return None, []
    allk = chain(t["sym"], exp, t["right"])
    ks = [k for k in allk if (spot <= k <= spot * 1.2 if call else spot * 0.8 <= k <= spot)]
    ks = sorted(ks, key=lambda k: abs(k - spot))[:16]
    return exp, [store.occ(t["sym"], exp, k, t["right"]) for k in ks]


def stage_cands():
    by = collections.defaultdict(set)
    for t in signals():
        exp, cs = cands_of(t)
        by[t["date"]].update(cs)
    json.dump({d: sorted(v) for d, v in by.items()}, open(os.path.join(D, "passA.json"), "w"))
    print("pass A:", len(by), "days,", sum(len(v) for v in by.values()), "contract-days", flush=True)


def price_of(lst, label):
    days = sorted(lst); tot = 0.0
    sample = days[::max(1, len(days) // 25)]
    per = []
    for d in sample:
        syms = lst[d][:2000]
        c = sum(float(api("metadata.get_cost", dataset="OPRA.PILLAR", schema=s, stype_in="raw_symbol", symbols=",".join(pad(x) for x in syms),
                          start=utc(d, 0), end=utc(d, 391))) for s in ("cbbo-1m", "ohlcv-1m"))
        per.append(c / len(syms))
    n = sum(len(v) for v in lst.values()); tot = st.mean(per) * n
    print(f"{label}: {n:,} contract-days x ${st.mean(per):.5f} (sampled {len(sample)} days) = ~${tot:,.2f}", flush=True)
    return tot


def stage_cost():
    A = json.load(open(os.path.join(D, "passA.json")))
    tot = price_of(A, "pass A")
    nd = len({(r["sym"], r["date"]) for r in signals()})
    print(f"definitions (already bought by the defs stage): {nd:,} stock-days x ~$0.007 = ~${nd * 0.007:,.2f}")
    if tot > MAX_USD: raise SystemExit(f"pass A ~${tot:,.0f} > MAX_USD ${MAX_USD:,.0f}: stopped")


def fetch_day(job):
    date, syms = job
    key = f"{date}|{len(syms)}|{syms[0]}|{syms[-1]}"
    if odb.execute("SELECT 1 FROM done WHERE key=?", (key,)).fetchone(): return 0
    bars = collections.defaultdict(list)
    for r in rows("ohlcv-1m", syms, utc(date, 0), utc(date, 390)):
        m = nymin(r["ts_event"])
        if 0 <= m < 390: bars[r["symbol"].replace(" ", "")].append([m, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), int(r["volume"])])
    q = [(r["symbol"].replace(" ", ""), nymin(r["ts_recv"]), r["bid_px_00"], r["ask_px_00"], r["bid_sz_00"], r["ask_sz_00"])
         for r in rows("cbbo-1m", syms, utc(date, -1), utc(date, 391))]
    oi = {r["symbol"].replace(" ", ""): r["quantity"] for r in rows("statistics", syms, f"{date}T00:00", utc(date, 0)) if r.get("stat_type") == "9"}
    # quotes and OI: merged with what the day's file already holds (pass A and pass B share a day's file)
    for path, head, new in ((os.path.join(QDIR, f"{date}.csv.gz"), ["contract", "minute", "bid", "ask", "bid_sz", "ask_sz"], q),
                            (os.path.join(QDIR, "oi", f"{date}.csv.gz"), ["contract", "oi"], sorted(oi.items()))):
        old = [tuple(r) for r in csv.reader(gzip.open(path, "rt"))][1:] if os.path.exists(path) else []
        have = {r[0] for r in new}
        allr = [r for r in old if r[0] not in have] + [tuple(map(str, r)) for r in new]
        with gzip.open(path + ".tmp", "wt") as f:
            w = csv.writer(f); w.writerow(head); w.writerows(allr)
        os.replace(path + ".tmp", path)
    for s, v in bars.items():
        odb.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?)", (s, date, json.dumps(sorted(v))))
    odb.execute("INSERT OR REPLACE INTO done VALUES (?)", (key,)); odb.commit()
    return len(q)


def stage_fetch(name):
    L = json.load(open(os.path.join(D, f"{name}.json")))
    jobs = [(d, sorted(v)) for d, v in sorted(L.items()) if v]
    done = 0
    with ThreadPoolExecutor(6) as ex:
        for n in ex.map(fetch_day, jobs):
            done += 1
            if done % 25 == 0: print(f"{name} {done}/{len(jobs)} days", flush=True)
    print(f"{name} done: {len(jobs)} days", flush=True)


def pick(t):
    m = int(t["minute"])
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], float(t["price"]))
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    return p[0] if p else None


def stage_pick():
    Bl = collections.defaultdict(set); n = 0
    for t in signals():
        c = pick(t)
        if not c: continue
        n += 1
        for d in CAL[IDX[t["date"]] + 1:]:
            if d > c[1]: break
            Bl[d].add(c[0])
    json.dump({d: sorted(v) for d, v in Bl.items()}, open(os.path.join(D, "passB.json"), "w"))
    print(f"picked {n}; pass B: {sum(len(v) for v in Bl.values())} contract-days on {len(Bl)} days", flush=True)


def walk(t):
    c = pick(t)
    if not c: return None
    m = int(t["minute"])
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    r = {k: sim.result(rcost, real, z) for k, z in (("r1", 0.01), ("r15", 0.015), ("r2", 0.02), ("r3", 0.03))}
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    held = {}
    for mm in range(m, 390):
        k = RB.quote(c[0], t["date"], mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return dict(kind=t["kind"], date=t["date"], minute=m, sym=t["sym"], right=t["right"], d2=int(float(t["c_t"]) < 1.8),
                news_ok=t["news_ok"], contract=c[0], cost=rcost, quoted=int(rcost != cost), held=held, **r)


def stage_run():
    S = signals()
    with mp.Pool(8) as pool: R = [r for r in pool.map(walk, S, chunksize=8) if r]
    with open(os.path.join(D, "trades.csv"), "w") as f:
        w = csv.DictWriter(f, [k for k in R[0] if k != "held"], extrasaction="ignore"); w.writeheader(); w.writerows(R)
    main = [r for r in R if r["kind"] == "main" and r["news_ok"]]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["date"], r["sym"], r["right"])].append(r)
    print(f"\n### {YEAR}, his {YEAR} list ({len(LIST)} stocks), 2.7 at minute fills, REAL Databento quotes; {len(main)} main legs "
          f"({sum(r['quoted'] for r in main) / max(1, len(main)):.0%} priced on a quote)\n")
    print("| Size | Trades | Winners | Per trade at $10K | Median | End / worst drop | Without the best 5 | Best 5 | Giants · non-giant sum |\n|---|---|---|---|---|---|---|---|---|")
    out = {}
    for size, (full, halfk) in ((0.02, ("r2", "r1")), (0.03, ("r3", "r15"))):
        E = []
        for r in main:
            E.append((r["date"], r["minute"], 1.0, r[full], r["sym"]))
            if not r["d2"]: continue
            for a in sorted(adds[(r["date"], r["sym"], r["right"])], key=lambda q: q["minute"]):
                if a["minute"] <= r["minute"]: continue
                share, up = r["held"].get(a["minute"], (0, None))
                if share > 0 and up is not None and up > 0: E.append((a["date"], a["minute"], 0.5, a[halfk], a["sym"]))
                break
        E.sort()
        usd = [1e4 * e[2] * max(-1, e[3]) for e in E]
        pnl = [dict(date=e[0], pnl=str(u)) for e, u in zip(E, usd)]
        acct, dd = account(pnl, size)
        top = sorted(range(len(E)), key=lambda i: -usd[i])
        a5, _ = account([p for i, p in enumerate(pnl) if i not in set(top[:5])], size)
        g = {i for i in range(len(E)) if E[i][3] >= 3}
        s = dict(n=len(E), win=sum(e[3] > 0 for e in E) / max(1, len(E)), per=sum(usd) / max(1, len(E)), med=st.median(usd) if usd else 0,
                 acct=acct, dd=dd, no5=a5, best5=sum(usd[i] for i in top[:5]), giants=len(g), nongiant=sum(u for i, u in enumerate(usd) if i not in g),
                 top=[(E[i][0], E[i][4], round(usd[i])) for i in top[:5]])
        out[str(size)] = s
        print(f"| {size:.0%} | {s['n']} | {s['win']:.0%} | {s['per']:+,.0f} | {s['med']:+,.0f} | ${s['acct']:,.0f} / {s['dd']:.0%} | ${s['no5']:,.0f} | {s['best5']:+,.0f} | {s['giants']} · {s['nongiant']:+,.0f} |")
    print("best 5:", out["0.02"]["top"])
    json.dump(out, open(os.path.join(D, "summary.json"), "w"), indent=1)


if __name__ == "__main__":
    for s in STAGES:
        print(f"== {YEAR} {s}", flush=True)
        if s in ("fetchA", "fetchB"): stage_fetch("passA" if s == "fetchA" else "passB")
        else: globals()[f"stage_{s}"]()
