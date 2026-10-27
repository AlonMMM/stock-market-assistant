"""Download the 1-second data for the champion's entries (the user, 2026-10-27: "Full set, $6.46", priced by
sec_cost.py): the stock's 1-second bars (Databento EQUS.MINI ohlcv-1s) for the whole entry day, and the bought
option's 1-second book (OPRA cbbo-1s from 2025-02-20, every change of the best bid/ask, cmbp-1, before it) from 2
minutes before the signal to 10 after. The entries: export_champ.py's champ rows (fair list) and floor_exception's
Favorites rows (IBIT floor, no cheap fallback).

  node --env-file=.env <dir>/run.mjs sec_fetch_main.py <export dir>      (from the app repo root)
-> sec_cache/main/stock/<date>_<sym>.csv.gz (second, open, high, low, close, volume; second 0 = 09:30:00 New York)
   sec_cache/main/opt/<date>_<contract>_<minute>.csv.gz (second, bid, ask, bid size, ask size: the book as it ended)
"""
import base64, csv, datetime as dt, gzip, http.client, io, os, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dbx_fetch as F

B = "data/local/x/bt"
OUT = os.path.join(HERE, "sec_cache", "main")
NY = ZoneInfo("America/New_York")
SEC1 = "2025-02-20"


def utc(date, sec):
    t = dt.datetime.fromisoformat(date).replace(hour=9, minute=30, tzinfo=NY) + dt.timedelta(seconds=sec)
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def sec_of(ts, date):
    """Seconds after 09:30 New York of a Databento pretty timestamp (UTC, nanoseconds: the whole second is enough)."""
    t = dt.datetime.fromisoformat(ts[:19]).replace(tzinfo=dt.timezone.utc).astimezone(NY)
    return int((t - t.replace(hour=9, minute=30, second=0, microsecond=0)).total_seconds())


def get(dataset, schema, symbol, date, a, z):
    data = urllib.parse.urlencode(dict(dataset=dataset, schema=schema, stype_in="raw_symbol", encoding="csv", pretty_px="true",
                                       pretty_ts="true", symbols=symbol, start=utc(date, a), end=utc(date, z))).encode()
    req = urllib.request.Request("https://hist.databento.com/v0/timeseries.get_range", data=data, headers={"Authorization": F.AUTH})
    for tries in range(6):
        try: return urllib.request.urlopen(req, timeout=600).read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 422: return ""
            if tries == 5: raise
            time.sleep(15 * (tries + 1))
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead):
            if tries == 5: raise
            time.sleep(15 * (tries + 1))


def save(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path + ".tmp", "wt") as f: csv.writer(f).writerows(rows)
    os.replace(path + ".tmp", path)


def stock(job):
    date, sym = job
    p = os.path.join(OUT, "stock", f"{date}_{sym}.csv.gz")
    if os.path.exists(p): return 0
    text = get("EQUS.MINI", "ohlcv-1s", sym, date, 0, 390 * 60)
    rows = [(sec_of(r["ts_event"], date), r["open"], r["high"], r["low"], r["close"], r["volume"]) for r in csv.DictReader(io.StringIO(text))]
    save(p, rows)
    return len(rows)


def option(job):
    date, c, m = job
    p = os.path.join(OUT, "opt", f"{date}_{c}_{m}.csv.gz")
    if os.path.exists(p): return 0
    one_s = date >= SEC1
    text = get("OPRA.PILLAR", "cbbo-1s" if one_s else "cmbp-1", F.pad(c), date, (m - 2) * 60 - (0 if one_s else 60), (m + 10) * 60)
    book = {}
    for r in csv.DictReader(io.StringIO(text)):
        if not (r.get("bid_px_00") and r.get("ask_px_00")): continue
        s = sec_of(r["ts_recv"], date)
        if one_s: s -= 1   # a cbbo-1s row stamped second s + 1 is the book as second s ended (leg_seconds.py)
        book[s] = (r["bid_px_00"], r["ask_px_00"], r.get("bid_sz_00", ""), r.get("ask_sz_00", ""))   # cmbp-1: the last change in a second
    save(p, [(s, *v) for s, v in sorted(book.items())])
    return len(book)


def main():
    rows = [r for r in csv.DictReader(open(f"{sys.argv[1]}/champ_trades.csv")) if r["version"] == "champ"]
    rows += [r for r in csv.DictReader(open(f"{B}/floor_exception_trades.csv")) if r["src"] == "fav" and r["exc"] == "ibit" and r["fb"] == "none"]
    stocks = sorted({(r["date"], r["sym"]) for r in rows})
    opts = sorted({(r["date"], r["contract"], int(r["minute"])) for r in rows})
    print(len(stocks), "stock-days,", len(opts), "option windows", flush=True)
    with ThreadPoolExecutor(6) as ex:
        for n, k in enumerate(ex.map(stock, stocks), 1):
            if n % 200 == 0: print("stock", n, flush=True)
        for n, k in enumerate(ex.map(option, opts), 1):
            if n % 500 == 0: print("option", n, flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
