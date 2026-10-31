"""Download real quotes (Databento OPRA cbbo-1m: the best bid/ask each minute) and open interest (statistics, stat_type
9) for a contract list, one request a day.
  dbx_fetch.py              dbx_list.csv (the Volume bot)      -> dbx_cache/<date>.csv.gz, to 15:31 NY
  dbx_fetch.py indi         indi_dbx_list.csv (the Main bot)   -> dbx_cache/indi/<date>.csv.gz, to the close
Quote rows: contract, minute (from 09:30 NY: the book as that minute began), bid, ask, bid_sz, ask_sz.
Open interest -> dbx_cache/[indi/]oi/<date>.csv.gz: contract, oi (published before the open).
Needs DATABENTO_API_KEY. Skips days done.
"""
import base64, collections, csv, gzip, io, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
INDI = "indi" in sys.argv[1:]
OUT = os.path.join(HERE, "dbx_cache", "indi") if INDI else os.path.join(HERE, "dbx_cache")
LIST = "indi_dbx_list.csv" if INDI else "dbx_list.csv"
END = 391 if INDI else 362
# open2 (pullback2.py, 2026-10-28): the contracts the opening-pullback versions buy, to the close -> dbx_cache/open2
if "open2" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open2"), "open2_dbx_list.csv", 391
if "open3" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open3"), "open3_dbx_list.csv", 391   # entry_start.py
if "open4" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open4"), "open4_dbx_list.csv", 391   # bell_entry.py
if "open5" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open5"), "open5_dbx_list.csv", 391   # ndx_test.py
if "uso" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "uso"), "uso_dbx_list.csv", 391   # favorites.txt's USO, merged into dbx_cache/fav
if "open7" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open7"), "open7_dbx_list.csv", 391   # liq_test.py
if "open8" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open8"), "open8_dbx_list.csv", 391   # liq_test.py LQ_NAME=lev12
if "open9" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open9"), "open9_dbx_list.csv", 391   # expiry_rules.py
if "open10" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open10"), "open10_dbx_list.csv", 391   # mkt_rules.py
if "open11" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open11"), "open11_dbx_list.csv", 391   # indi_close.py
if "open12" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open12"), "open12_dbx_list.csv", 391   # indi_close.py IC_SET=rs
if "open13" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open13"), "open13_dbx_list.csv", 391   # d2_fix.py
if "shockt" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "shockt"), "shockt_dbx_list.csv", 391   # shock_test.py
if "open14" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open14"), "open14_dbx_list.csv", 391   # indi_close.py IC_SET=vol
if "open15" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open15"), "open15_dbx_list.csv", 391   # indi_close.py IC_SET=d2b
if "open16" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open16"), "open16_dbx_list.csv", 391   # indi_close.py IC_SET=d3
if "open17" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open17"), "open17_dbx_list.csv", 391   # late_start.py
if "open18" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open18"), "open18_dbx_list.csv", 391   # thin_retry.py
if "open19" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open19"), "open19_dbx_list.csv", 391   # open_window.py
if "open20" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open20"), "open20_dbx_list.csv", 391   # ten_back.py
if "open21" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open21"), "open21_dbx_list.csv", 391   # liquid_free.py
if "open22" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open22"), "open22_dbx_list.csv", 391   # indi_close.py IC_SET=many
if "open23" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open23"), "open23_dbx_list.csv", 391   # indi_close.py IC_SET=fill
if "open24" in sys.argv[1:]: OUT, LIST, END = os.path.join(HERE, "dbx_cache", "open24"), "open24_dbx_list.csv", 391   # indi_close.py IC_SET=score
NY = ZoneInfo("America/New_York")
AUTH = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
HEAD = ["contract", "minute", "bid", "ask", "bid_sz", "ask_sz"]


def pad(s):
    m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", s)
    return m.group(1).ljust(6) + m.group(2)


def utc(date, minute):
    h, m = divmod(570 + minute, 60)
    return datetime.fromisoformat(f"{date}T{h:02d}:{m:02d}").replace(tzinfo=NY).astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M")


def get(syms, schema, start, end):
    for i in range(0, len(syms), 2000):
        data = urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", schema=schema, stype_in="raw_symbol", encoding="csv",
            pretty_px="true", pretty_ts="true", map_symbols="true", symbols=",".join(pad(s) for s in syms[i:i + 2000]),
            start=start, end=end)).encode()
        req = urllib.request.Request("https://hist.databento.com/v0/timeseries.get_range", data=data, headers={"Authorization": AUTH})
        for tries in range(6):   # a busy server (504 and the like): wait and ask again
            try:
                text = urllib.request.urlopen(req, timeout=900).read().decode()
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if tries == 5: raise
                print("retry", e, flush=True); time.sleep(20 * (tries + 1))
        yield from csv.DictReader(io.StringIO(text))


def save(path, head, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path + ".tmp", "wt") as f:
        w = csv.writer(f); w.writerow(head); w.writerows(rows)
    os.replace(path + ".tmp", path)


def fresh(path, head):
    """Done already in this format (a file from before the sizes is fetched again)."""
    if not os.path.exists(path): return False
    with gzip.open(path, "rt") as f: return f.readline().strip() == ",".join(head)


def fetch(date, syms, start):
    syms, n = sorted(syms), 0
    path = os.path.join(OUT, f"{date}.csv.gz")
    if not fresh(path, HEAD):
        rows = []
        for r in get(syms, "cbbo-1m", utc(date, start - 1), utc(date, END)):
            t = datetime.fromisoformat(r["ts_recv"].replace("Z", "+00:00")).astimezone(NY)
            rows.append((r["symbol"].replace(" ", ""), t.hour * 60 + t.minute - 570, r["bid_px_00"], r["ask_px_00"], r["bid_sz_00"], r["ask_sz_00"]))
        save(path, HEAD, rows); n = len(rows)
    path = os.path.join(OUT, "oi", f"{date}.csv.gz")
    if not os.path.exists(path):
        oi = {}
        for r in get(syms, "statistics", f"{date}T00:00", utc(date, 0)):
            if r["stat_type"] == "9": oi[r["symbol"].replace(" ", "")] = r["quantity"]
        save(path, ["contract", "oi"], sorted(oi.items()))
    return n


def main():
    by, first = collections.defaultdict(set), {}
    for r in csv.DictReader(open(os.path.join(HERE, LIST))):
        by[r["date"]].add(r["contract"]); first[r["date"]] = min(first.get(r["date"], 999), int(r["minute"]))
    days = sorted(by, reverse=True)   # the newest first: the 12 months are ready soonest
    done = 0
    with ThreadPoolExecutor(10) as ex:
        for d, n in zip(days, ex.map(lambda d: fetch(d, by[d], first[d]), days)):
            done += 1
            print(f"{done}/{len(days)} {d} {n} rows", flush=True)


if __name__ == "__main__": main()
