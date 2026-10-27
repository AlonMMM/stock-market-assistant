"""One local SQLite for the research data (the user, 2026-10-27: "please upload all the data you have to our dbs - you can
create dbs if not exists, including the data already downloaded (1sec stocks)"). Imports, incrementally (a file is read
once; the `imports` table remembers it):
  option_quotes_1m  Databento OPRA cbbo-1m: the best bid/ask (and sizes) each minute; minute m = the book as minute m
                    began (real_bench.quote's convention); src = the cache folder (indi / fav / extra / root)
  option_oi         the open interest at the previous close (Databento statistics), per contract and date
  stock_bars_1s     Databento EQUS.MINI ohlcv-1s; second 0 = 09:30:00 New York. src main (the champion's entry days,
                    full bars) or alerts (the Volume bot's alert windows, close only)
  option_book_1s    the option's best bid/ask at the end of each second (cbbo-1s, or the last cmbp-1 change in it);
                    src main (champion entries), alerts / alerts2 (Volume bot)
  analyst_actions   analyst_news.py's rating headlines
  bt_trades, bt_fills  the Bot vs Indi benchmark (all_trades.csv; fills at +-5% / +-10% / real / fair)
Licensed market data (Databento, Alpaca): local research use only; data/local/ is not in Git.

  python3 <dir>/build_research_db.py <db path> [<benchmark dir>]      (from the app repo root)
"""
import csv, glob, gzip, os, sqlite3, sys
HERE = os.path.dirname(os.path.abspath(__file__))
B = "data/local/x/bt"
csv.field_size_limit(10 ** 9)

SCHEMA = """
CREATE TABLE IF NOT EXISTS imports (path TEXT PRIMARY KEY, rows INTEGER, at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS option_quotes_1m (contract TEXT, date TEXT, minute INTEGER, bid REAL, ask REAL, bid_sz REAL, ask_sz REAL, src TEXT,
  PRIMARY KEY (contract, date, minute)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS option_oi (contract TEXT, date TEXT, oi INTEGER, PRIMARY KEY (contract, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS stock_bars_1s (sym TEXT, date TEXT, sec INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL, src TEXT,
  PRIMARY KEY (sym, date, sec)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS option_book_1s (contract TEXT, date TEXT, sec INTEGER, bid REAL, ask REAL, bid_sz REAL, ask_sz REAL, src TEXT,
  PRIMARY KEY (contract, date, sec)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS analyst_actions (time TEXT, date TEXT, minute INTEGER, sym TEXT, firm TEXT, known INTEGER, kind TEXT,
  direction INTEGER, headline TEXT, PRIMARY KEY (sym, time, headline)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bt_trades (version TEXT, key TEXT PRIMARY KEY, date TEXT, time TEXT, minute INTEGER, sym TEXT, right TEXT,
  contract TEXT, iv TEXT, ret REAL, exit TEXT, overnight INTEGER, ret_2pct REAL, ret_4pct REAL, ret_5pct REAL, added INTEGER);
CREATE TABLE IF NOT EXISTS bt_fills (model TEXT, key TEXT, cost REAL, ret REAL, ret_2pct REAL, ret_4pct REAL, ret_5pct REAL, exit TEXT,
  overnight INTEGER, steps TEXT, cov REAL, buy_m INTEGER, buy_px REAL, PRIMARY KEY (model, key)) WITHOUT ROWID;
"""


def num(x):
    try: return float(x)
    except (TypeError, ValueError): return None


def done(db, path): return db.execute("SELECT 1 FROM imports WHERE path = ?", (path,)).fetchone() is not None


def mark(db, path, n):
    db.execute("INSERT OR REPLACE INTO imports (path, rows) VALUES (?, ?)", (path, n)); db.commit()


def quotes(db):
    for folder, src in ((os.path.join(HERE, "dbx_cache"), "root"), (os.path.join(HERE, "dbx_cache", "indi"), "indi"),
                        (os.path.join(HERE, "dbx_cache", "fav"), "fav"), (os.path.join(HERE, "dbx_cache", "extra"), "extra")):
        for p in sorted(glob.glob(os.path.join(folder, "*.csv.gz"))):
            if done(db, p): continue
            date = os.path.basename(p)[:10]
            rows = [(r["contract"], date, int(r["minute"]), num(r["bid"]), num(r["ask"]), num(r.get("bid_sz")), num(r.get("ask_sz")), src)
                    for r in csv.DictReader(gzip.open(p, "rt"))]
            db.executemany("INSERT OR IGNORE INTO option_quotes_1m VALUES (?,?,?,?,?,?,?,?)", rows); mark(db, p, len(rows))
        for p in sorted(glob.glob(os.path.join(folder, "oi", "*.csv.gz"))):
            if done(db, p): continue
            date = os.path.basename(p)[:10]
            rows = [(r["contract"], date, int(float(r["oi"]))) for r in csv.DictReader(gzip.open(p, "rt")) if r.get("oi")]
            db.executemany("INSERT OR IGNORE INTO option_oi VALUES (?,?,?)", rows); mark(db, p, len(rows))
    print("quotes and OI:", db.execute("SELECT COUNT(*) FROM option_quotes_1m").fetchone()[0], "/", db.execute("SELECT COUNT(*) FROM option_oi").fetchone()[0], flush=True)


def seconds(db):
    sc = os.path.join(HERE, "sec_cache")
    for p in sorted(glob.glob(os.path.join(sc, "main", "stock", "*.csv.gz"))):
        if done(db, p): continue
        date, sym = os.path.basename(p)[:-7].split("_", 1)
        rows = [(sym, date, int(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4]), num(r[5]), "main") for r in csv.reader(gzip.open(p, "rt")) if r]
        db.executemany("INSERT OR REPLACE INTO stock_bars_1s VALUES (?,?,?,?,?,?,?,?,?)", rows); mark(db, p, len(rows))
    for p in sorted(glob.glob(os.path.join(sc, "stock", "*.csv.gz"))):
        if done(db, p): continue
        date, sym = os.path.basename(p)[:-7].split("_")[:2]   # <date>_<sym>_<alert second>[_tag]
        rows = [(sym, date, int(r[0]), None, None, None, num(r[1]), None, "alerts") for r in csv.reader(gzip.open(p, "rt")) if r]
        db.executemany("INSERT OR IGNORE INTO stock_bars_1s VALUES (?,?,?,?,?,?,?,?,?)", rows); mark(db, p, len(rows))
    for sub, src in (("main/opt", "main"), ("opt2", "alerts2"), ("opt", "alerts")):
        for p in sorted(glob.glob(os.path.join(sc, sub, "*.csv.gz"))):
            if done(db, p): continue
            date, c = os.path.basename(p)[:-7].split("_")[:2]
            rows = []
            for r in csv.reader(gzip.open(p, "rt")):
                if not r: continue
                rows.append((c, date, int(r[0]), num(r[1]), num(r[2]), num(r[3]) if len(r) > 3 else None, num(r[4]) if len(r) > 4 else None, src))
            db.executemany("INSERT OR IGNORE INTO option_book_1s VALUES (?,?,?,?,?,?,?,?)", rows); mark(db, p, len(rows))
    print("1-second stock / option rows:", db.execute("SELECT COUNT(*) FROM stock_bars_1s").fetchone()[0], "/", db.execute("SELECT COUNT(*) FROM option_book_1s").fetchone()[0], flush=True)


def analyst(db):
    p = os.path.join(B, "analyst_actions.csv")
    if not os.path.exists(p): return
    rows = [(r["time"], r["date"], int(r["minute"]), r["sym"], r["firm"], int(r["known"]), r["kind"], int(r["direction"]), r["headline"]) for r in csv.DictReader(open(p))]
    db.executemany("INSERT OR REPLACE INTO analyst_actions VALUES (?,?,?,?,?,?,?,?,?)", rows); mark(db, p, len(rows))
    print("analyst actions:", len(rows), flush=True)


def bench(db, d):
    cols = ["version", "key", "date", "time", "minute", "sym", "right", "contract", "iv", "ret", "exit", "overnight", "ret_2pct", "ret_4pct", "ret_5pct", "added"]
    rows = [tuple(r.get(k) for k in cols) for r in csv.DictReader(open(os.path.join(d, "all_trades.csv")))]
    db.execute("DELETE FROM bt_trades"); db.executemany(f"INSERT INTO bt_trades VALUES ({','.join('?' * len(cols))})", rows)
    db.execute("DELETE FROM bt_fills")
    for model in ("f5", "f10", "real", "fair"):
        p = os.path.join(d, f"fills_{model}.csv")
        if not os.path.exists(p): continue
        fr = [(model, r["key"], num(r.get("cost") or r.get("buy_px")), num(r["ret"]), num(r["ret_2pct"]), num(r["ret_4pct"]), num(r["ret_5pct"]), r.get("exit"),
               r.get("overnight"), r.get("steps"), num(r.get("cov")), r.get("buy_m"), num(r.get("buy_px"))) for r in csv.DictReader(open(p))]
        db.executemany("INSERT OR REPLACE INTO bt_fills VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", fr)
    db.commit()
    print("benchmark trades / fills:", db.execute("SELECT COUNT(*) FROM bt_trades").fetchone()[0], "/", db.execute("SELECT COUNT(*) FROM bt_fills").fetchone()[0], flush=True)


def main():
    db = sqlite3.connect(sys.argv[1])
    db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA synchronous=NORMAL")
    db.executescript(SCHEMA)
    quotes(db); seconds(db); analyst(db)
    if len(sys.argv) > 2: bench(db, sys.argv[2])
    db.execute("PRAGMA optimize"); db.close()


if __name__ == "__main__":
    main()
