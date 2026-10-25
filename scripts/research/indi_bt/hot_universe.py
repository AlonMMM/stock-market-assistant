"""Hot stocks from the whole optionable US market, point in time (the user, 2026-10-25: "find hot stocks from that period,
not from the 191 or only the S&P: retail stocks too"). Set before looking at results:
  pool:  Alpaca's active US equities with listed options, leveraged / inverse ETFs out (today's listing: names delisted
         since 2024 are missing);
  liquid at the time: price >= $5 and median daily dollar volume >= $100M over the lookback;
  hot:   the 50 most volatile liquid stocks (spread of daily close-to-close returns) over the 6 months before the month
         (3 beside it), recomputed every month from 2024-02.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs hot_universe.py fetch    (from the repo root)
  python3 ../sma-indi-backtest/scripts/research/indi_bt/hot_universe.py pick [6|3]
"""
import json, os, re, sqlite3, statistics as st, sys, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import _get

DB = "data/local/x/bt/daily_all.sqlite"
A, Z = "2023-07-01", "2026-10-24"
LEVERED = re.compile(r"\b(2x|3x|-2x|-3x|1\.5x|2\.0x|ultra|ultrapro|leveraged|inverse|bear|bull|daily|short)\b", re.I)
TOP, MIN_PX, MIN_DV = 50, 5.0, 100e6
# Funds that are not stocks: leveraged / inverse ones the name filter missed, a commodity fund, and bitcoin funds that
# duplicate IBIT (in Indi's core; ETHA, ether, stays). Cleanup asked by the user after seeing the first lists.
FUNDS_OUT = {"KOLD", "ZSL", "UNG", "BITO", "ARKB", "FBTC", "GBTC"}


def fetch():
    assets = _get("https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity")
    pool = sorted(a["symbol"] for a in assets if a.get("tradable") and "has_options" in (a.get("attributes") or [])
                  and a["exchange"] in ("NYSE", "NASDAQ", "AMEX", "ARCA", "BATS") and not LEVERED.search(a.get("name") or "") and "." not in a["symbol"] and "/" not in a["symbol"])
    print(len(assets), "assets,", len(pool), "optionable", flush=True)
    con = sqlite3.connect(DB)
    con.execute("CREATE TABLE IF NOT EXISTS d (sym TEXT, date TEXT, c REAL, v REAL, PRIMARY KEY (sym, date))")
    con.execute("CREATE TABLE IF NOT EXISTS names (sym TEXT PRIMARY KEY, name TEXT)")
    con.executemany("INSERT OR REPLACE INTO names VALUES (?, ?)", [(a["symbol"], a.get("name") or "") for a in assets if a["symbol"] in set(pool)])
    done = {r[0] for r in con.execute("SELECT DISTINCT sym FROM d")}
    todo = [s for s in pool if s not in done]
    for i in range(0, len(todo), 50):
        batch = todo[i:i + 50]; token = None
        while True:
            q = dict(symbols=",".join(batch), timeframe="1Day", start=A, end=Z, adjustment="all", feed="sip", limit=10000)
            if token: q["page_token"] = token
            r = _get("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(q))
            rows = [(s, b["t"][:10], b["c"], b["v"]) for s, bars in (r.get("bars") or {}).items() for b in bars]
            con.executemany("INSERT OR REPLACE INTO d VALUES (?, ?, ?, ?)", rows)
            token = r.get("next_page_token")
            if not token: break
        con.commit()
        print(f"{i + len(batch)} / {len(todo)}", flush=True)


def month_add(m, k):
    y, mo = int(m[:4]), int(m[5:7]) + k
    while mo < 1: y, mo = y - 1, mo + 12
    while mo > 12: y, mo = y + 1, mo - 12
    return f"{y:04d}-{mo:02d}"


def hot_by_month(back=6, top=TOP):
    con = sqlite3.connect(DB)
    data = {}
    for s, d, c, v in con.execute("SELECT sym, date, c, v FROM d ORDER BY sym, date"): data.setdefault(s, []).append((d, c, v))
    months, m = [], "2024-02"
    while m <= "2026-10": months.append(m); m = month_add(m, 1)
    out = {}
    for m in months:
        a, z = month_add(m, -back) + "-01", m + "-01"
        score = {}
        for s, rows in data.items():
            if s in FUNDS_OUT: continue
            w = [r for r in rows if a <= r[0] < z]
            if len(w) < 0.8 * 21 * back: continue
            if w[-1][1] < MIN_PX or st.median(r[1] * r[2] for r in w) < MIN_DV: continue
            score[s] = st.pstdev(w[i][1] / w[i - 1][1] - 1 for i in range(1, len(w)))
        out[m] = sorted(score, key=lambda s: -score[s])[:top]
    return out


def pick(back):
    H = hot_by_month(back)
    con = sqlite3.connect(DB)
    names = dict(con.execute("SELECT sym, name FROM names"))
    from collections import Counter
    cnt = Counter(s for v in H.values() for s in v)
    print(f"lookback {back} months, top {TOP} a month, {len(cnt)} different stocks over {len(H)} months")
    for m in sorted(H)[::3]: print(m, " ".join(H[m]))
    print("\nmost often hot:", ", ".join(f"{s} {n}" for s, n in cnt.most_common(60)))
    json.dump(H, open(f"data/local/x/bt/hot_{back}m.json", "w"))


if __name__ == "__main__":
    if sys.argv[1] == "fetch": fetch()
    else: pick(int(sys.argv[2]) if len(sys.argv) > 2 else 6)
