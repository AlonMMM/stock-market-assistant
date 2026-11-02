# Read-only snapshot of the production D1 (sma-bars-cache) rows the Volume
# backtest reads for the period, into a local sqlite. Only SELECTs.
import json, os, sqlite3, subprocess, sys

DEPLOY = "/Users/alonmo/Desktop/Personal/sma-deploy"
OUT = sys.argv[1]
LO, HI = os.environ.get("PARITY_FROM", "2026-07-31"), os.environ.get("PARITY_TO", "2026-10-30")
TABLES = {
    "volume_alerts": ("CREATE TABLE IF NOT EXISTS volume_alerts (symbol TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, second INTEGER NOT NULL, price REAL NOT NULL, up INTEGER NOT NULL, PRIMARY KEY (symbol, date, kind, second))", ["symbol", "date", "kind", "second", "price", "up"], 4000),
    "stock_seconds": ("CREATE TABLE IF NOT EXISTS stock_seconds (symbol TEXT NOT NULL, date TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, rows TEXT NOT NULL, PRIMARY KEY (symbol, date, start))", ["symbol", "date", "start", "end", "rows"], 2500),
    "option_seconds": ("CREATE TABLE IF NOT EXISTS option_seconds (contract TEXT NOT NULL, date TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, rows TEXT NOT NULL, PRIMARY KEY (contract, date, start))", ["contract", "date", "start", "end", "rows"], 5000),
    "option_quotes": ("CREATE TABLE IF NOT EXISTS option_quotes (contract TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL, quotes TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (contract, date, source))", ["contract", "date", "source", "quotes", "stored_at"], 2000),
    "option_bars": ("CREATE TABLE IF NOT EXISTS option_bars (contract TEXT NOT NULL, date TEXT NOT NULL, bars TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (contract, date))", ["contract", "date", "bars", "stored_at"], 1500),
}


def query(sql):
    p = subprocess.run(["npx", "wrangler", "d1", "execute", "sma-bars-cache", "--remote", "--json", "--command", sql],
                       cwd=DEPLOY, capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        raise SystemExit(p.stdout[-2000:] + p.stderr[-2000:])
    return json.loads(p.stdout)[0]["results"]


db = sqlite3.connect(OUT)
only = sys.argv[2:] or list(TABLES)
for t in only:
    ddl, cols, page = TABLES[t]
    db.execute(ddl)
    last, n = 0, 0
    while True:
        rows = query(f"SELECT rowid AS rid, {', '.join(cols)} FROM {t} WHERE date BETWEEN '{LO}' AND '{HI}' AND rowid > {last} ORDER BY rowid LIMIT {page}")
        if not rows:
            break
        db.executemany(f"INSERT OR REPLACE INTO {t} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                       [[r[c] for c in cols] for r in rows])
        db.commit()
        last = rows[-1]["rid"]
        n += len(rows)
        print(t, n, flush=True)
    print("done", t, n, flush=True)
