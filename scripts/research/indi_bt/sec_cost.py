"""Databento's price for 1-second data at the champion's entries (the user, 2026-10-27: "Timing with 1-second stock
moves"), nothing downloaded. The champion's buys (export_champ.py's champ rows on the fair list, floor_exception's
Favorites rows) on the stock and the option:
  stock   EQUS.MINI ohlcv-1s, 15 minutes before the signal to 30 after (entry timing), and the whole entry day (stops)
  option  OPRA.PILLAR cbbo-1s for the bought contract, 2 minutes before the signal to 10 after
  python3 <dir>/sec_cost.py <export dir>      (needs DATABENTO_API_KEY: node --env-file=.env <dir>/run.mjs sec_cost.py <dir>)
"""
import collections, csv, datetime as dt, os, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dbx_fetch as F

B = "data/local/x/bt"
NY = ZoneInfo("America/New_York")


def utc(date, minute):
    t = dt.datetime.fromisoformat(date).replace(hour=9, minute=30, tzinfo=NY) + dt.timedelta(minutes=minute)
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


FAILED = collections.Counter()


def cost(dataset, schema, syms, a, z):
    data = urllib.parse.urlencode(dict(dataset=dataset, schema=schema, stype_in="raw_symbol", symbols=",".join(syms), start=a, end=z)).encode()
    req = urllib.request.Request("https://hist.databento.com/v0/metadata.get_cost", data=data, headers={"Authorization": F.AUTH})
    for tries in range(6):
        try: return float(urllib.request.urlopen(req, timeout=300).read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 422: FAILED[(dataset, schema, a[:4])] += 1; return 0.0   # not available for that request
            if tries == 5: raise
            time.sleep(10 * (tries + 1))
        except Exception:
            if tries == 5: raise
            time.sleep(10 * (tries + 1))


def main():
    rows = [r for r in csv.DictReader(open(f"{sys.argv[1]}/champ_trades.csv")) if r["version"] == "champ"]
    rows += [dict(r, contract=r["contract"]) for r in csv.DictReader(open(f"{B}/floor_exception_trades.csv"))
             if r["src"] == "fav" and r["exc"] == "ibit" and r["fb"] == "none"]
    ent = {(r["date"], r["sym"], int(r["minute"]), r["contract"]) for r in rows}
    print(len(ent), "entries on", len({e[0] for e in ent}), "days", flush=True)
    jobs = []
    by_day = collections.defaultdict(list)
    for e in ent: by_day[e[0]].append(e)
    for d, es in by_day.items():
        for date, sym, m, c in es:
            jobs.append(("window", "EQUS.MINI", "ohlcv-1s", [sym], utc(d, m - 15), utc(d, m + 30)))
            # cbbo-1s starts 2025-02-20; before it every change of the best bid/ask (cmbp-1), as leg_seconds.py
            jobs.append(("option", "OPRA.PILLAR", "cbbo-1s" if d >= "2025-02-20" else "cmbp-1", [F.pad(c)], utc(d, m - 2), utc(d, m + 10)))
        jobs.append(("day", "EQUS.MINI", "ohlcv-1s", sorted({e[1] for e in es}), utc(d, 0), utc(d, 390)))
    tot = collections.Counter()
    with ThreadPoolExecutor(8) as ex:
        for (kind, *_), c in zip(jobs, ex.map(lambda j: cost(*j[1:]), jobs)): tot[kind] += c
    print(f"stock, entry windows (-15 to +30 min): ${tot['window']:,.2f}")
    print(f"stock, whole entry days:              ${tot['day']:,.2f}")
    print(f"option book, -2 to +10 min:           ${tot['option']:,.2f}")
    print("refused (422), by dataset / schema / year:", dict(FAILED))


if __name__ == "__main__":
    main()
