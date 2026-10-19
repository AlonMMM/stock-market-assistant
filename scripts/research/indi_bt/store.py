"""Shared pieces of the rule backtest: Alpaca market data cached in SQLite, the trading calendar,
1-minute bar access in session minutes, and Black-Scholes for implied volatility and delta.

Data lives in data/local/x/bt (not in Git). Credentials come from ALPACA_API_KEY / ALPACA_API_SECRET;
run the scripts through `node --env-file=.env` (see README.md) so the keys never touch a file here.
"""
import json, math, os, sqlite3, time, urllib.parse, urllib.request, urllib.error, datetime as dt
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, "params.json")))
DATA = os.environ.get("BT_DATA", "data/local/x/bt")
os.makedirs(DATA, exist_ok=True)
db = sqlite3.connect(os.path.join(DATA, "market.sqlite"), timeout=120)
db.executescript("""
CREATE TABLE IF NOT EXISTS bars (symbol TEXT, date TEXT, bars TEXT, PRIMARY KEY (symbol, date));
CREATE TABLE IF NOT EXISTS done (key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS chain (und TEXT, expiry TEXT, right TEXT, strikes TEXT, PRIMARY KEY (und, expiry, right));
""")


# ---- Alpaca ----
def _get(url):
    h = {"APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"], "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET"]}
    for attempt in range(9):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
                out = json.load(r)
            time.sleep(0.32)  # under 200 requests a minute
            return out
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500: raise
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(3 * (attempt + 1))
    raise RuntimeError("Alpaca keeps failing: " + url)


def session_utc(date):
    """09:30 and 16:00 New York on a date, as UTC ISO strings."""
    d = dt.date.fromisoformat(date)
    a = dt.datetime(d.year, d.month, d.day, 9, 30, tzinfo=NY).astimezone(dt.timezone.utc)
    b = dt.datetime(d.year, d.month, d.day, 16, 0, tzinfo=NY).astimezone(dt.timezone.utc)
    return a.strftime("%Y-%m-%dT%H:%M:%SZ"), b.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_bars(kind, symbols, start, end, key=None):
    """Regular-session 1-min bars for symbols between two dates (inclusive), stored per symbol and day.
    kind: 'stocks' (SIP, raw prices) or 'options' (OCC symbols)."""
    key = key or f"{kind}|{','.join(symbols)}|{start}|{end}"
    if db.execute("SELECT 1 FROM done WHERE key=?", (key,)).fetchone(): return
    base = "https://data.alpaca.markets/v2/stocks/bars" if kind == "stocks" else "https://data.alpaca.markets/v1beta1/options/bars"
    got, token = {}, None
    while True:
        q = dict(symbols=",".join(symbols), timeframe="1Min", start=session_utc(start)[0], end=session_utc(end)[1], limit=10000, sort="asc")
        if kind == "stocks": q.update(feed="sip", adjustment="raw")
        if token: q["page_token"] = token
        j = _get(base + "?" + urllib.parse.urlencode(q))
        for s, bs in (j.get("bars") or {}).items():
            for b in bs:
                t = dt.datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(NY)
                m = (t.hour * 60 + t.minute) - 570  # session minute: 09:30 -> 0
                if 0 <= m < 390:
                    got.setdefault((s, t.date().isoformat()), []).append([m, b["o"], b["h"], b["l"], b["c"], b["v"]])
        token = j.get("next_page_token")
        if not token: break
    db.executemany("INSERT OR REPLACE INTO bars VALUES (?,?,?)", [(s, d, json.dumps(v)) for (s, d), v in got.items()])
    db.execute("INSERT OR REPLACE INTO done VALUES (?)", (key,))
    db.commit()


def chain(und, expiry, right):
    """Strikes listed for one underlying, expiry and right (expired contracts included)."""
    r = db.execute("SELECT strikes FROM chain WHERE und=? AND expiry=? AND right=?", (und, expiry, right)).fetchone()
    if r: return json.loads(r[0])
    strikes = set()
    for status in ("inactive", "active"):
        token = None
        while True:
            q = dict(underlying_symbols=und, expiration_date=expiry, type="call" if right == "C" else "put", status=status, limit=10000)
            if token: q["page_token"] = token
            j = _get("https://paper-api.alpaca.markets/v2/options/contracts?" + urllib.parse.urlencode(q))
            strikes |= {float(c["strike_price"]) for c in j.get("option_contracts") or [] if c["root_symbol"] == und}
            token = j.get("next_page_token")
            if not token: break
    s = sorted(strikes)
    db.execute("INSERT OR REPLACE INTO chain VALUES (?,?,?,?)", (und, expiry, right, json.dumps(s)))
    db.commit()
    return s


def expiries(und, start, end):
    """Expiration dates listed for an underlying in [start, end]."""
    key = f"exp|{und}|{start}|{end}"
    r = db.execute("SELECT strikes FROM chain WHERE und=? AND expiry=? AND right='X'", (und, key)).fetchone()
    if r: return json.loads(r[0])
    out = set()
    for status in ("inactive", "active"):
        token = None
        while True:
            q = dict(underlying_symbols=und, expiration_date_gte=start, expiration_date_lte=end, type="call", status=status, limit=10000)
            if token: q["page_token"] = token
            j = _get("https://paper-api.alpaca.markets/v2/options/contracts?" + urllib.parse.urlencode(q))
            out |= {c["expiration_date"] for c in j.get("option_contracts") or [] if c["root_symbol"] == und}
            token = j.get("next_page_token")
            if not token: break
    e = sorted(out)
    db.execute("INSERT OR REPLACE INTO chain VALUES (?,?,?,?)", (und, key, "X", json.dumps(e)))
    db.commit()
    return e


def occ(und, expiry, strike, right):
    return f"{und}{expiry[2:4]}{expiry[5:7]}{expiry[8:10]}{right}{round(strike * 1000):08d}"


# ---- bars ----
_cache = {}


def day(sym, date):
    """[[minute, o, h, l, c, v], ...] for the regular session (minute 0 = 09:30), [] if none."""
    k = (sym, date)
    if k not in _cache:
        if len(_cache) > 20000: _cache.clear()
        r = db.execute("SELECT bars FROM bars WHERE symbol=? AND date=?", k).fetchone()
        _cache[k] = json.loads(r[0]) if r else []
    return _cache[k]


def calendar():
    """Trading days = days with SPY bars."""
    return [r[0] for r in db.execute("SELECT date FROM bars WHERE symbol='SPY' ORDER BY date")]


# ---- Black-Scholes ----
def _n(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(S, K, T, v, r, call):
    d1 = (math.log(S / K) + (r + v * v / 2) * T) / (v * math.sqrt(T))
    d2 = d1 - v * math.sqrt(T)
    if call: return S * _n(d1) - K * math.exp(-r * T) * _n(d2), _n(d1)
    return K * math.exp(-r * T) * _n(-d2) - S * _n(-d1), _n(d1) - 1


def delta(price, S, K, T, r, call):
    """|delta| from the implied volatility of a price, None when the price is outside the model's range."""
    lo, hi = 0.01, 6.0
    if not (bs(S, K, T, lo, r, call)[0] < price < bs(S, K, T, hi, r, call)[0]): return None
    for _ in range(60):
        m = (lo + hi) / 2
        if bs(S, K, T, m, r, call)[0] < price: lo = m
        else: hi = m
    return abs(bs(S, K, T, m, r, call)[1])


def years_to_expiry(date, minute, expiry):
    now = dt.datetime.fromisoformat(date).replace(tzinfo=NY) + dt.timedelta(minutes=570 + minute)
    exp = dt.datetime.fromisoformat(expiry).replace(tzinfo=NY) + dt.timedelta(hours=16)
    return max((exp - now).total_seconds(), 600) / (365 * 86400)
