"""A point-in-time "hot list": which stocks traded hard each month, from market data only (the user 2026-10-31: "we do
not know what hot stock was at that time. How can we get hot stock?", then "ok build it").

At the first trading day of each month, every US stock is scored on the 20 trading days before it (never the month
itself): dollar volume, volume against its own 120-day average, the daily range, the size of the 20-day move. The top N
is that month's list. The score is tuned on 2024-2025 against the names Indi actually opened (his actions.csv, silexx)
and checked on 2023 and 2026, so the frozen rule can then pick the 2022 / 2023 lists for dbx22.py.

Data: Alpaca daily bars (SIP, split-adjusted), every US equity on Alpaca, active AND inactive (delisted names such as
FRC / PACW / BBBY stay in), Sep 2020 - Oct 2026, into data/local/x/bt/daily_all.sqlite. Free.

  node --env-file=.env <dir>/run.mjs hot_scan.py assets      the universe (all US equities, active + inactive)
  node --env-file=.env <dir>/run.mjs hot_scan.py daily       the daily bars, resumable
  python3 hot_scan.py score                                  the variants, recall of his names, tune / check
  python3 hot_scan.py lists <variant> <N>                    -> data/local/x/bt/hot_lists_<variant>_<N>.json {month: [syms]}
"""
import collections, csv, json, math, os, sqlite3, statistics as st, sys, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BT_VARIANT", "v2")

B = "data/local/x/bt"
DB = sqlite3.connect(f"{B}/daily_all.sqlite")
DB.executescript("""
CREATE TABLE IF NOT EXISTS asset (symbol TEXT PRIMARY KEY, exchange TEXT, status TEXT, name TEXT);
CREATE TABLE IF NOT EXISTS day (symbol TEXT, date TEXT, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY (symbol, date));
CREATE TABLE IF NOT EXISTS done (key TEXT PRIMARY KEY);
""")
EXCH = {"NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"}
START, END = "2020-09-01", "2026-10-30"
SKIP = {"SPXW", "SPX", "NDXP", "VIXW", "XSP", "RUT", "NDX"}
TUNE, CHECK = ("2024", "2025"), ("2023", "2026")


def stage_assets():
    import store
    n = 0
    for status in ("active", "inactive"):
        q = dict(status=status, asset_class="us_equity")
        for a in store._get("https://paper-api.alpaca.markets/v2/assets?" + urllib.parse.urlencode(q)):
            if a.get("exchange") not in EXCH or "." in a["symbol"] or "/" in a["symbol"]: continue
            DB.execute("INSERT OR REPLACE INTO asset VALUES (?,?,?,?)", (a["symbol"], a["exchange"], status, a.get("name", "")))
            n += 1
    DB.commit()
    print("assets:", n, dict(DB.execute("SELECT status, COUNT(*) FROM asset GROUP BY status").fetchall()))


def stage_daily():
    import store
    import re, urllib.error
    # plain tickers only (the inactive list also holds CUSIP-like codes of rights, CVRs and escrows, which Alpaca refuses)
    syms = [r[0] for r in DB.execute("SELECT symbol FROM asset ORDER BY symbol") if re.fullmatch(r"[A-Z]{1,5}", r[0])]
    print(len(syms), "plain tickers", flush=True)
    for i in range(0, len(syms), 100):
        part = syms[i:i + 100]; key = f"d|{part[0]}|{part[-1]}|{len(part)}"
        if DB.execute("SELECT 1 FROM done WHERE key=?", (key,)).fetchone(): continue
        try: rows = fetch_daily(store, part)
        except urllib.error.HTTPError:   # one bad ticker spoils the batch: one at a time
            rows = []
            for x in part:
                try: rows += fetch_daily(store, [x])
                except urllib.error.HTTPError: pass
        DB.executemany("INSERT OR REPLACE INTO day VALUES (?,?,?,?,?,?,?)", rows)
        DB.execute("INSERT INTO done VALUES (?)", (key,)); DB.commit()
        if i % 2000 == 0: print(f"daily {i}/{len(syms)}", flush=True)
    print("daily done", DB.execute("SELECT COUNT(*), COUNT(DISTINCT symbol) FROM day").fetchone(), flush=True)


def fetch_daily(store, part):
    token, rows = None, []
    while True:
        q = dict(symbols=",".join(part), timeframe="1Day", start=START, end=END, limit=10000, feed="sip", adjustment="split", sort="asc")
        if token: q["page_token"] = token
        j = store._get("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(q))
        for s, bs in (j.get("bars") or {}).items():
            for b in bs:
                if b["c"] * b["v"] < 1e6: continue   # never a candidate: under $1M a day
                rows.append((s, b["t"][:10], b["o"], b["h"], b["l"], b["c"], b["v"]))
        token = j.get("next_page_token")
        if not token: break
    return rows


# ---- scoring ----
def load():
    by = collections.defaultdict(dict)
    for s, d, o, h, l, c, v in DB.execute("SELECT symbol, date, o, h, l, c, v FROM day"):
        by[s][d] = (o, h, l, c, v)
    cal = sorted({d for s in ("SPY", "QQQ", "AAPL") for d in by.get(s, {})})
    return by, cal


def months(cal):
    """The first trading day of every month from 2021-02 on."""
    out, seen = [], set()
    for d in cal:
        if d[:7] not in seen and d >= "2021-02-01": seen.add(d[:7]); out.append(d)
    return out


_LEV = None


def leveraged():
    """Leveraged / inverse ETFs and volatility notes (2x / 3x / -1x, VIX): they trade hard but are not a stock's move."""
    global _LEV
    if _LEV is None:
        import re
        pat = re.compile(r"(\b[23]X\b|-[123]X|ULTRA|BULL|BEAR|LEVERAGED|INVERSE|VIX|VOLATILITY|SHORT )", re.I)
        _LEV = {s for s, n in DB.execute("SELECT symbol, name FROM asset") if pat.search(n or "")}
    return _LEV


def features(by, cal, first):
    """Every stock's numbers on the 20 trading days before `first` (and the 120 before them for its usual volume)."""
    i = cal.index(first)
    w20, w120 = cal[i - 20:i], cal[max(0, i - 140):i - 20]
    out = {}
    for s, dd in by.items():
        if s in SKIP or s in leveraged(): continue
        b = [dd[d] for d in w20 if d in dd]
        if len(b) < 15: continue
        c = b[-1][3]
        if c < 5: continue
        dv = st.mean(x[3] * x[4] for x in b)
        if dv < 20e6: continue
        old = [dd[d][4] for d in w120 if d in dd]
        rvol = st.mean(x[4] for x in b) / st.mean(old) if len(old) >= 40 else 1.0
        rng = st.median((x[1] - x[2]) / x[3] for x in b)
        first_c = next(dd[d][3] for d in w20 if d in dd)
        mv = abs(math.log(c / first_c))
        out[s] = dict(dv=dv, rvol=rvol, rng=rng, mv=mv)
    return out


def rank_pct(F, k):
    xs = sorted(F, key=lambda s: F[s][k])
    return {s: i / max(1, len(xs) - 1) for i, s in enumerate(xs)}


VARIANTS = {
    # name: weights on the percentile ranks (dollar volume, relative volume, range, move)
    "dv": dict(dv=1),
    "dv_rng": dict(dv=1, rng=1),
    "dv_rvol": dict(dv=1, rvol=1),
    "dv_rng_rvol": dict(dv=1, rng=1, rvol=1),
    "dv2_rng_rvol_mv": dict(dv=2, rng=1, rvol=1, mv=1),
    "dv2_rng": dict(dv=2, rng=1),
    "dv3_rng2_rvol": dict(dv=3, rng=2, rvol=1),
    "h50_rng_400": dict(core=0.5, pool=400, by=("rng",)),
    "h50_rvol_400": dict(core=0.5, pool=400, by=("rvol",)),
    "h50_rngrvol_400": dict(core=0.5, pool=400, by=("rng", "rvol")),
    "h70_rngrvol_400": dict(core=0.7, pool=400, by=("rng", "rvol")),
    "h70_rngrvol_250": dict(core=0.7, pool=250, by=("rng", "rvol")),
    "h50_rngrvolmv_300": dict(core=0.5, pool=300, by=("rng", "rvol", "mv")),
}


def pick(F, w, n):
    if "core" in w:   # a hybrid: the `core` share of n by dollar volume, the rest the top movers (w["by"]) among the pool largest
        big = sorted(F, key=lambda s: -F[s]["dv"])
        k = round(n * w["core"]); out = big[:k]
        pool = {s: F[s] for s in big[k:w["pool"]]}
        R = {x: rank_pct(pool, x) for x in w["by"]}
        sc = {s: sum(R[x][s] for x in w["by"]) for s in pool}
        return out + sorted(sc, key=lambda s: -sc[s])[:n - k]
    R = {k: rank_pct(F, k) for k in w}
    sc = {s: sum(w[k] * R[k][s] for k in w) for s in F}
    return sorted(sc, key=lambda s: -sc[s])[:n]


def his_opens():
    out = []
    for y in ("2023", "2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] == "silexx" and r["action"] == "open":
                s = r["contract"].split()[0]
                if s not in SKIP: out.append((r["date"], s))
    return out


def stage_score():
    by, cal = load()
    M = months(cal)
    H = his_opens()
    F = {m: features(by, cal, m) for m in M if m >= "2022-12-01"}
    print(f"{len(by)} stocks with any $1M day; universe per month (>= $5, >= $20M a day): median {st.median(len(f) for f in F.values()):.0f}")
    mo = lambda d: max(m for m in M if m <= d)
    print("\n### baseline: his own names of the 12 months before (the fair-list idea)\n")
    for y in TUNE + CHECK:
        R_ = [(d, s) for d, s in H if d[:4] == y]
        prior = lambda d: {s for dd, s in H if dd < d and dd >= str(int(d[:4]) - 1) + d[4:]}
        hit = sum(s in prior(d) for d, s in R_)
        sz = st.median(len(prior(d)) for d, s in R_)
        print(f"{y}: {hit / len(R_):.0%} of his opens (list size median {sz:.0f}){' (no 2022 history: low)' if y == '2023' else ''}")
    for n in (80, 100):
        print(f"\n### top {n} a month: share of his opens (stock-index options out) whose stock is on that month's list\n")
        print("| Variant | " + " | ".join(TUNE + CHECK) + " | tune | check | his names covered (2024-25) |\n|---|" + "---|" * (len(TUNE + CHECK) + 3))
        for name, w in VARIANTS.items():
            L = {m: set(pick(F[m], w, n)) for m in F}
            hit = collections.Counter(); tot = collections.Counter(); names = collections.defaultdict(set); got = collections.defaultdict(set)
            for d, s in H:
                m = mo(d)
                if m not in L: continue
                y = d[:4]; tot[y] += 1; names[y].add(s)
                if s in L[m]: hit[y] += 1; got[y].add(s)
            rec = {y: hit[y] / max(1, tot[y]) for y in tot}
            tn = sum(hit[y] for y in TUNE) / sum(tot[y] for y in TUNE); ck = sum(hit[y] for y in CHECK) / sum(tot[y] for y in CHECK)
            cov = sum(len(got[y]) for y in TUNE) / sum(len(names[y]) for y in TUNE)
            print(f"| {name} | " + " | ".join(f"{rec.get(y, 0):.0%}" for y in TUNE + CHECK) + f" | {tn:.0%} | {ck:.0%} | {cov:.0%} |", flush=True)


def stage_lists(name, n):
    by, cal = load()
    out = {m[:7]: pick(features(by, cal, m), VARIANTS[name], n) for m in months(cal)}
    p = f"{B}/hot_lists_{name}_{n}.json"
    json.dump(out, open(p, "w"), indent=0)
    print("->", p, len(out), "months")


if __name__ == "__main__":
    s = sys.argv[1]
    if s == "assets": stage_assets()
    elif s == "daily": stage_daily()
    elif s == "score": stage_score()
    elif s == "lists": stage_lists(sys.argv[2], int(sys.argv[3]))
