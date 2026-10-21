"""Context data for the entry-context study: sector ETFs (regular session, 1-min, like the stocks) and the
pre-market (04:00-09:30, 5-min bars) for the universe, SPY and QQQ, summed per stock-day.

  node --env-file=.env scripts/research/indi_bt/run.mjs fetch_context.py [start] [end]
"""
import datetime as dt, json, os, sys, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, db, fetch_bars, _get, NY

ETF = ["QQQ", "SMH", "XLK", "XLC", "XLY", "XBI", "ARKK", "IGV", "KWEB", "XLI", "TAN", "BITO", "IWM", "VIXY"]
db.execute("CREATE TABLE IF NOT EXISTS pre (symbol TEXT, date TEXT, vol REAL, open REAL, last REAL, high REAL, low REAL, n INT, PRIMARY KEY (symbol, date))")


def pre(symbols, start, end):
    key = f"pre|{','.join(symbols)}|{start}|{end}"
    if db.execute("SELECT 1 FROM done WHERE key=?", (key,)).fetchone(): return
    got, token = {}, None
    while True:
        q = dict(symbols=",".join(symbols), timeframe="5Min", start=f"{start}T08:00:00Z", end=f"{end}T15:00:00Z", limit=10000,
                 sort="asc", feed="sip", adjustment="raw")
        if token: q["page_token"] = token
        j = _get("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(q))
        for s, bs in (j.get("bars") or {}).items():
            for b in bs:
                t = dt.datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(NY)
                if 4 <= t.hour and t.hour * 60 + t.minute < 570:
                    got.setdefault((s, t.date().isoformat()), []).append(b)
        token = j.get("next_page_token")
        if not token: break
    for (s, d), bs in got.items():
        db.execute("INSERT OR REPLACE INTO pre VALUES (?,?,?,?,?,?,?,?)", (s, d, sum(b["v"] for b in bs), bs[0]["o"], bs[-1]["c"],
                                                                         max(b["h"] for b in bs), min(b["l"] for b in bs), len(bs)))
    db.execute("INSERT OR REPLACE INTO done VALUES (?)", (key,)); db.commit()


def main(start="2022-11-01", end="2026-10-12"):
    d = dt.date.fromisoformat(start); syms = ["SPY", "QQQ"] + P["universe"]
    while d.isoformat() <= end:
        e = min((d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1), dt.date.fromisoformat(end))
        for i in range(0, len(ETF), 7): fetch_bars("stocks", ETF[i:i + 7], d.isoformat(), e.isoformat())
        for i in range(0, len(syms), 6): pre(syms[i:i + 6], d.isoformat(), e.isoformat())
        print(d.isoformat()[:7], "done", flush=True)
        d = e + dt.timedelta(days=1)


if __name__ == "__main__":
    main(*sys.argv[1:3])
