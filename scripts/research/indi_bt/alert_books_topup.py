"""The strikes alert_books_hist.py should have bought (the user, 2026-11-01: "but I thought i alredy boguht this data" ...
"yes"). The backfill chose each alert's |delta| 0.10-0.35 band from the stock's 20-day volatility x 1.15; on fast days
the options price far above that, so the real 0.20 pick lay outside the band (ORCL 2026-10-28 14:49: the backtest wants
the 140 call, the band held 133-138) and the alert had no book. This rebuilds every band the way the backtest reads
delta (packages/trading/src/strangle/backtest.ts chainQuotes): per side, the 16 out-of-the-money strikes nearest the
stock within 20%, delta from the implied volatility of each one's last 1-minute Alpaca bar (10 minutes old at most),
at every minute from the alert to 10 minutes after it (the side can come that late). The strikes with |delta|
0.10-0.35 the old band lacks are the top-up: the same windows as the backfill (1 s: alert - 2 s to + 300 s; 1 m: the
stock-day to 15:30).

  node --env-file=.env <dir>/run.mjs alert_books_topup.py list|cost   (from the app repo root)

Writes data/local/x/alertbooks/topup_requests.csv (alert_books_hist.py's columns); `cost` fills its cost column
(metadata.get_cost, free) and prints the total.
"""
import collections, csv, datetime as dt, json, math, os, sys, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alert_books_hist as ab

OUT = f"{ab.DIR}/topup_requests.csv"
RATE, NEAR, BAR_AGE, SIDE_WAIT = 0.045, 16, 10, 10
ONLY = set(filter(None, os.environ.get("AB_SYMS", "").split(",")))   # a test on a few stocks
DAYS = {}   # (symbol, date) -> the stock's minute bars, read in the main thread (store.py's SQLite is one thread's)
COLS = ["kind", "symbol", "date", "second", "expiry", "start", "end", "contracts", "deltas", "cost"]


def ncdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(S, K, T, v, call):
    d1 = (math.log(S / K) + (RATE + v * v / 2) * T) / (v * math.sqrt(T))
    d2 = d1 - v * math.sqrt(T)
    if call: return S * ncdf(d1) - K * math.exp(-RATE * T) * ncdf(d2), ncdf(d1)
    return K * math.exp(-RATE * T) * ncdf(-d2) - S * ncdf(-d1), ncdf(d1) - 1


def implied_delta(price, S, K, T, call):
    """|delta| at the implied volatility of price; None outside 0.01-6 (the backtest's impliedDelta)."""
    lo, hi = 0.01, 6.0
    if not (bs(S, K, T, lo, call)[0] < price < bs(S, K, T, hi, call)[0]): return None
    for _ in range(60):
        m = (lo + hi) / 2
        if bs(S, K, T, m, call)[0] < price: lo = m
        else: hi = m
    return abs(bs(S, K, T, m, call)[1])


def years(date, minute, expiry):
    days = (dt.date.fromisoformat(expiry) - dt.date.fromisoformat(date)).days
    return max(days * 1440 + 960 - (570 + minute), 10) / (365 * 1440)


def near(cs, exp, sym, spot, call):
    own = [c for c in cs if c["expiration_date"] == exp and c["symbol"][:-15] == sym and (c["type"] == "call") == call]
    k = lambda c: float(c["strike_price"])
    inside = [c for c in own if (spot <= k(c) <= spot * 1.2 if call else spot * 0.8 <= k(c) <= spot)]
    return [c["symbol"] for c in sorted(inside, key=lambda c: abs(k(c) - spot))[:NEAR]]


def option_bars(sym, date, contracts):
    """{contract: [[m, c], ...]} of the session, Alpaca's 1-minute option bars (free), kept on disk."""
    p = f"{ab.DIR}/optbars/{sym}_{date}.json"
    have = json.load(open(p)) if os.path.exists(p) else {}
    want = sorted(set(contracts) - set(have))
    for i in range(0, len(want), 100):
        token, part = None, want[i:i + 100]
        for c in part: have[c] = []
        while True:
            q = dict(symbols=",".join(part), timeframe="1Min", start=ab.iso(ab.at(date, 0)) + "Z",
                     end=ab.iso(ab.at(date, 390 * 60)) + "Z", limit=10000)
            if token: q["page_token"] = token
            r = ab.alpaca("https://data.alpaca.markets/v1beta1/options/bars?" + urllib.parse.urlencode(q))
            for c, bars in (r.get("bars") or {}).items():
                for b in bars:
                    t = dt.datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(ab.NY)
                    have[c].append([t.hour * 60 + t.minute - 570, b["c"]])
            token = r.get("next_page_token")
            if not token: break
    if want:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        json.dump(have, open(p + ".tmp", "w")); os.replace(p + ".tmp", p)
    return have


def last_close(bars, m):
    got = [c for bm, c in bars if bm <= m]
    ok = [bm for bm, _ in bars if bm <= m]
    return got[-1] if got and m - ok[-1] <= BAR_AGE else None


def stock_day(key, alerts_of, old):
    sym, date = key
    cs, _ = ab.chain_vol(sym, date)
    exps = sorted({c["expiration_date"] for c in cs if c["symbol"][:-15] == sym})
    if not exps: return [], []
    exp = exps[0]
    closes = {b[0]: b[4] for b in DAYS[key]}
    spot_at = lambda m: closes.get(max([x for x in closes if x <= m], default=-1))
    plan = []   # (kind, alert, [(minute, spot, call, contracts)])
    for kind, a in alerts_of:
        m0, steps = a["sec"] // 60, []
        for m in range(m0, min(m0 + SIDE_WAIT, 389) + 1):
            spot = spot_at(m)
            if spot:
                for call in (True, False): steps.append((m, spot, call, near(cs, exp, sym, spot, call)))
        plan.append((kind, a, steps))
    bars = option_bars(sym, date, {c for _, _, st in plan for *_, cons in st for c in cons})
    rows, stats, union_new = [], [], {}
    old_minute = set(old.get(("minute", sym, date), "").split(";")) if old.get(("minute", sym, date)) else set()
    for kind, a, steps in plan:
        band = {}
        for m, spot, call, cons in steps:
            for c in cons:
                px = last_close(bars.get(c, []), m)
                if px is None: continue
                d = implied_delta(px, spot, float(c[-8:]) / 1000, years(date, m, exp), call)
                if d is not None and ab.DELTA[0] <= d <= ab.DELTA[1]: band.setdefault(c, d if call else -d)
        had = set((old.get((kind, sym, date, str(a["sec"]))) or "").split(";")) - {""}
        new = sorted(set(band) - had)
        stats.append(dict(kind=kind, symbol=sym, date=date, second=a["sec"], band=len(band), had=len(had), new=len(new)))
        if not new: continue
        for c in new:
            if c not in old_minute: union_new.setdefault(c, band[c])
        t0 = ab.at(date, a["sec"])
        rows.append(dict(kind=kind, symbol=sym, date=date, second=a["sec"], expiry=exp,
                         start=ab.iso(t0 - dt.timedelta(seconds=2)), end=ab.iso(t0 + dt.timedelta(seconds=ab.FINE_S + 1)),
                         contracts=";".join(new), deltas=";".join(f"{band[c]:.3f}" for c in new), cost=""))
    if union_new:
        first = min(a["sec"] for _, a in alerts_of)
        m0 = first // 60
        rows.append(dict(kind="minute", symbol=sym, date=date, second=first, expiry=exp,
                         start=ab.iso(ab.at(date, (m0 - 1) * 60)), end=ab.iso(ab.at(date, (ab.LAST_MIN + 2) * 60)),
                         contracts=";".join(sorted(union_new)),
                         deltas=";".join(f"{union_new[c]:.3f}" for c in sorted(union_new)), cost=""))
    return rows, stats


def build():
    old = {}
    for r in ab.read_list():
        key = ("minute", r["symbol"], r["date"]) if r["kind"] == "minute" else (r["kind"], r["symbol"], r["date"], r["second"])
        old[key] = r["contracts"]
    by = collections.defaultdict(list)
    for kind in ("plan", "shock"):
        for a in json.load(open(f"{ab.DIR}/alerts_{kind}.json")):
            if ab.FROM <= a["date"] <= ab.TO and (not ONLY or a["sym"] in ONLY): by[(a["sym"], a["date"])].append((kind, a))
    rows, stats = [], []
    keys = sorted(by)
    for k in keys: DAYS[k] = ab.minute_bars(*k)
    with ThreadPoolExecutor(4) as ex:
        for n, (r, s) in enumerate(ex.map(lambda k: stock_day(k, sorted(by[k], key=lambda x: x[1]["sec"]), old), keys)):
            rows += r; stats += s
            if n % 100 == 0: print(f"{n}/{len(keys)} stock-days", flush=True)
    with open(OUT + ".tmp", "w", newline="") as f:
        w = csv.DictWriter(f, COLS); w.writeheader(); w.writerows(rows)
    os.replace(OUT + ".tmp", OUT)
    json.dump(stats, open(f"{ab.DIR}/topup_stats.json", "w"))
    for kind in ("plan", "shock"):
        s = [x for x in stats if x["kind"] == kind]
        print(f"{kind}: {len(s)} alerts, {sum(x['new'] > 0 for x in s)} miss strikes of the real band; "
              f"{sum(x['new'] for x in s)} contract-windows to add (the old bands held {sum(x['had'] for x in s)})")
    print(f"{sum(r['kind'] == 'minute' for r in rows)} stock-days need minute books for "
          f"{sum(len(r['contracts'].split(';')) for r in rows if r['kind'] == 'minute')} new contracts; wrote {OUT}")


def cost():
    rows = list(csv.DictReader(open(OUT)))
    def one(r):
        syms = [ab.pad(x) for x in r["contracts"].split(";")]
        try:
            return float(ab.dbx("metadata.get_cost", schema=ab.schema(r), symbols=",".join(syms), start=r["start"], end=r["end"]))
        except urllib.error.HTTPError as e:   # 422: Databento knows none of them
            if e.code != 422: raise
            return 0.0
    with ThreadPoolExecutor(8) as ex:
        for r, c in zip(rows, ex.map(one, rows)): r["cost"] = f"{c:.6f}"
    with open(OUT + ".tmp", "w", newline="") as f:
        w = csv.DictWriter(f, COLS); w.writeheader(); w.writerows(rows)
    os.replace(OUT + ".tmp", OUT)
    by = collections.defaultdict(float)
    for r in rows: by[ab.schema(r)] += float(r["cost"])
    print({k: round(v, 4) for k, v in by.items()}, f"total ${sum(by.values()):.2f} for {len(rows)} requests")


FIRST_RAW = ab.raw_path   # the backfill's own paths (fetch() points ab.raw_path at the top-up's)


def raw_path(r):
    """The top-up's raw Databento CSVs, beside the backfill's (alert_books_hist.store reads both)."""
    return FIRST_RAW(r).replace(f"{ab.DIR}/", f"{ab.DIR}/topup/", 1)


def fetch():
    """Downloads the priced list (alert_books_hist.fetch on the top-up's rows and paths; the same cap)."""
    ab.read_list = lambda: list(csv.DictReader(open(OUT)))
    ab.raw_path = raw_path
    ab.fetch()


def merge():
    """requests.csv gets the top-up's contracts on each window (the old file kept as requests_before_topup.csv), so
    alert_books_hist.py store builds every window from both downloads."""
    rows = ab.read_list()
    key = lambda r: (r["kind"], r["symbol"], r["date"]) + (() if r["kind"] == "minute" else (r["second"],))
    by = {key(r): r for r in rows}
    before = f"{ab.DIR}/requests_before_topup.csv"
    if not os.path.exists(before): os.replace(f"{ab.DIR}/requests.csv", before)
    rows = list(csv.DictReader(open(before)))
    by = {key(r): r for r in rows}
    added = 0
    for t in csv.DictReader(open(OUT)):
        if not os.path.exists(raw_path(t)): continue
        r = by.get(key(t))
        if r is None:
            rows.append(dict(t)); by[key(t)] = rows[-1]; added += 1
            continue
        have = r["contracts"].split(";") if r["contracts"] else []
        ds = r["deltas"].split(";") if r["deltas"] else []
        for c, d in zip(t["contracts"].split(";"), t["deltas"].split(";")):
            if c not in have: have.append(c); ds.append(d)
        r["contracts"], r["deltas"] = ";".join(have), ";".join(ds)
    ab.write_list(rows)
    print(f"requests.csv: {len(rows)} windows ({added} new ones), the top-up's contracts merged in")


if __name__ == "__main__":
    {"list": build, "cost": cost, "fetch": fetch, "merge": merge}[sys.argv[1] if len(sys.argv) > 1 else ""]()
