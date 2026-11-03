# Buys (timeseries.get_range) the Volume bot relative-alert test's missing books and writes them into the local backtest
# db (S/volyear/d1.sqlite, never the app's D1): 1-second books at the buys -> option_seconds (second s = the book as s
# ended: a cbbo-1s row stamped s + 1), minute books of the day -> option_quotes "databento" (minute m = the book as m
# closed: cbbo-1m row m, the book as m began, is stored as m - 1; quotes_upload.py's convention). Raw CSV kept in dbxq/raw.
import base64, csv, gzip, io, json, os, sqlite3, sys, time, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
auth = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
d = sys.argv[1]
raw = f"{d}/dbxq/raw"; os.makedirs(raw, exist_ok=True)
def utc(date, sec):
    h, r = divmod(34200 + sec, 3600); m, s = divmod(r, 60)
    return datetime.fromisoformat(f"{date}T{h:02d}:{m:02d}:{s:02d}").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
def pad(c):
    i = next(k for k, ch in enumerate(c) if ch.isdigit()); return c[:i].ljust(6) + c[i:]
def get(schema, contract, date, a, z, name):
    p = f"{raw}/{name}.csv"
    if os.path.exists(p): return open(p).read()
    data = urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", schema=schema, stype_in="raw_symbol", encoding="csv", pretty_px="true",
                                       pretty_ts="true", symbols=pad(contract), start=utc(date, a), end=utc(date, z))).encode()
    req = urllib.request.Request("https://hist.databento.com/v0/timeseries.get_range", data=data, headers={"Authorization": auth})
    for t in range(6):
        try: text = urllib.request.urlopen(req, timeout=300).read().decode(); break
        except Exception:
            if t == 5: raise
            time.sleep(10 * (t + 1))
    open(p, "w").write(text); return text
def secs(ts):
    t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(NY)
    return t.hour * 3600 + t.minute * 60 + t.second - 34200
pack = lambda rows: "gz:" + base64.b64encode(gzip.compress(json.dumps(rows, separators=(",", ":")).encode(), mtime=0)).decode()
db = sqlite3.connect(f"{d}/volyear/d1.sqlite")
now = int(time.time() * 1000)
n1 = n2 = 0
for date, c, f, t in json.load(open(f"{d}/relspy/sec_jobs.json")):
    a, z = f - 2, t + 14
    text = get("cbbo-1s", c, date, a, z + 1, f"s_{date}_{c}_{f}")
    rows = [[secs(r["ts_recv"]) - 1, float(r["bid_px_00"]), float(r["ask_px_00"])] for r in csv.DictReader(io.StringIO(text)) if r["bid_px_00"] and r["ask_px_00"]]
    if not rows: print("empty", date, c, f); continue
    db.execute("INSERT OR REPLACE INTO option_seconds (contract, date, start, end, rows) VALUES (?, ?, ?, ?, ?)", (c, date, a, z, pack(rows))); n1 += 1
for date, c in sorted({(x["date"], x["contract"]) for x in json.load(open(f"{d}/relspy/missing.json")) if x["kind"] == "minutes"}):
    text = get("cbbo-1m", c, date, 0, 23460, f"m_{date}_{c}")
    rows = [[secs(r["ts_recv"]) // 60 - 1, float(r["bid_px_00"]), float(r["ask_px_00"])] for r in csv.DictReader(io.StringIO(text)) if r["bid_px_00"] and r["ask_px_00"]]
    rows = [r for r in rows if 0 <= r[0] < 390]
    if not rows: print("empty minutes", date, c); continue
    db.execute("INSERT OR REPLACE INTO option_quotes (contract, date, source, quotes, stored_at) VALUES (?, ?, 'databento', ?, ?)", (c, date, pack(rows), now)); n2 += 1
db.commit()
print(f"stored: {n1} second windows, {n2} minute days")
