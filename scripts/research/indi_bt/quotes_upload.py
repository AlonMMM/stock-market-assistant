"""Upload real option quotes to the app's D1 (sma-bars-cache, table option_quotes) for the Backtest page's real bids
and asks (the user, 2026-10-31: "anytime we download something we will upload to the db - nothing needs to be done on
the server from Databento"). The server never talks to Databento; this Mac writes, the Worker only reads
(packages/market-data/src/option-quotes.ts in the app).

  python3 quotes_upload.py          every new or changed contract-day in dbx_cache/ (all folders), source "databento"
  python3 quotes_upload.py live     the bots' saved books (data/local/x/review/live/*.json from live_fetch.sh), "live"
  ... --dry                         write the SQL files and say what would go, run nothing

Run from the main checkout's root, after a dbx_fetch.py download or live_fetch.sh. One row per contract, day and
source: [[minute, bid, ask], ...] gzipped + base64 ("gz:"), minute = the session minute (09:30 NY = 0) whose CLOSE the
book is. The cache's rows are the book as a minute BEGAN (dbx_fetch.py), so row m is stored as minute m - 1.
What went up is kept in dbx_cache/uploaded.json (a hash per contract-day), so a rerun only sends what changed.
"""
import base64, collections, csv, datetime, glob, gzip, hashlib, json, os, subprocess, sys, time
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "dbx_cache")
MANIFEST = os.path.join(CACHE, "uploaded.json")
LIVE = "data/local/x/review/live"
DEPLOY = os.environ.get("SMA_DEPLOY", os.path.expanduser("~/Desktop/Personal/sma-deploy"))   # has wrangler.jsonc
OUT = os.path.join(HERE, "data", "quotes_sql")
FILE_BYTES = 40_000_000   # one wrangler import file
NY = ZoneInfo("America/New_York")
TABLE = ("CREATE TABLE IF NOT EXISTS option_quotes (contract TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL, "
         "quotes TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (contract, date, source));")


def pack(rows):
    text = json.dumps(rows, separators=(",", ":"))
    return "gz:" + base64.b64encode(gzip.compress(text.encode(), mtime=0)).decode()


def databento():
    """{(contract, date): [[m, bid, ask], ...]} from every quote file of the cache, one date at a time."""
    by_date = collections.defaultdict(list)
    for p in glob.glob(os.path.join(CACHE, "**", "*.csv.gz"), recursive=True):
        if f"{os.sep}oi{os.sep}" in p: continue   # open interest, not quotes
        by_date[os.path.basename(p)[:10]].append(p)
    for date in sorted(by_date):
        day = collections.defaultdict(dict)
        for p in by_date[date]:
            for r in csv.DictReader(gzip.open(p, "rt")):
                if not r.get("bid") or not r.get("ask"): continue
                m = int(r["minute"]) - 1   # the book as minute m+1 began = as minute m closed
                if m < 0: continue
                bid, ask = float(r["bid"]), float(r["ask"])
                if ask > 0 and 0 <= bid <= ask: day[r["contract"]][m] = [m, round(bid, 4), round(ask, 4)]
        for contract, mins in day.items():
            yield (contract, date), [mins[m] for m in sorted(mins)]


def live():
    """The books the bots saved (signal, buy decision, buy fill, each sale), by contract and New York day."""
    books = collections.defaultdict(dict)
    def add(contract, book):
        if not contract or not isinstance(book, dict) or "at" not in book: return
        t = datetime.datetime.fromtimestamp(book["at"] / 1000, NY)
        m = t.hour * 60 + t.minute - 570
        bid, ask = book.get("bid"), book.get("ask")
        if 0 <= m < 390 and isinstance(bid, (int, float)) and isinstance(ask, (int, float)) and ask > 0 and 0 <= bid <= ask:
            books[(contract, t.date().isoformat())][m] = [m, bid, ask]
    def walk(o):
        if isinstance(o, dict):
            c = o.get("contract")
            for k in ("book", "entryBook", "entryFillBook", "fillBook"):
                if k in o: add(c or o.get(k, {}).get("contract"), o[k])
            leg = o.get("leg") if isinstance(o.get("leg"), dict) else None
            for s in o.get("sales", []) + (leg or {}).get("orders", []):
                for k in ("book", "fillBook"):
                    if isinstance(s, dict) and k in s: add(c or (leg or {}).get("contract"), s[k])
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    for p in glob.glob(os.path.join(LIVE, "*.json")):
        walk(json.load(open(p)))
    for key, mins in books.items():
        yield key, [mins[m] for m in sorted(mins)]


def main():
    source = "live" if "live" in sys.argv[1:] else "databento"
    dry = "--dry" in sys.argv[1:]
    done = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {}
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, f"{source}_*.sql")): os.remove(old)
    files, part, size, rows, sent = [], [], 0, 0, {}
    now = int(time.time() * 1000)
    def flush():
        nonlocal part, size
        if not part: return
        p = os.path.join(OUT, f"{source}_{len(files):04d}.sql")
        open(p, "w").write(TABLE + "\n" + "\n".join(part) + "\n")
        files.append(p); part, size = [], 0
    for (contract, date), quotes in (live() if source == "live" else databento()):
        if not quotes: continue
        packed = pack(quotes)
        key = f"{contract}|{date}|{source}"
        h = hashlib.sha1(packed.encode()).hexdigest()[:16]
        if done.get(key) == h: continue
        line = (f"INSERT OR REPLACE INTO option_quotes (contract, date, source, quotes, stored_at) VALUES "
                f"('{contract}', '{date}', '{source}', '{packed}', {now});")
        part.append(line); size += len(line); rows += 1; sent[key] = h
        if size >= FILE_BYTES: flush()
    flush()
    mb = sum(os.path.getsize(f) for f in files) / 1e6
    print(f"{source}: {rows} contract-days to send, {len(files)} files, {mb:.0f} MB")
    if dry or not files: return
    for f in files:
        r = subprocess.run(["npx", "wrangler", "d1", "execute", "sma-bars-cache", "--remote", "--yes", "--file", f],
                           cwd=DEPLOY, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"{os.path.basename(f)} failed:\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}"); break
        # Only what went up is marked sent
        for line in open(f):
            if line.startswith("INSERT"):
                c, d, s = line.split("VALUES ('", 1)[1].split("'", 5)[0:5:2]
                k = f"{c}|{d}|{s}"
                done[k] = sent[k]
        json.dump(done, open(MANIFEST, "w"))
        print(f"{os.path.basename(f)} sent")
    print(f"{source}: {sum(1 for k in done if k.endswith('|' + source))} contract-days in D1")


if __name__ == "__main__":
    main()
