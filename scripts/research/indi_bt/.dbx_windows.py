# Temporary: buys the OPRA cbbo-1s books the shock tests lack (approved by the user 2026-11-02, quote $0.0053 for 55),
# one per contract and buy second, [second - 2, second + 14] as leg_seconds.fetch_opt reads them (a row stamped second
# s + 1 is the book as second s ended); writes [date, contract, start, end, rows] lines for the scratch D1.
#   node --env-file=.env scripts/research/indi_bt/run.mjs .dbx_windows.py <windows.json> <out.jsonl>
import base64, csv, io, json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
auth = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
def utc(date, sec):
    h, r = divmod(34200 + sec, 3600); m, s = divmod(r, 60)
    return datetime.fromisoformat(f"{date}T{h:02d}:{m:02d}:{s:02d}").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
def sec_of(ts):
    t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(NY)
    return t.hour * 3600 + t.minute * 60 + t.second - 34200
def pad(c):
    i = next(k for k, ch in enumerate(c) if ch.isdigit())
    return c[:i].ljust(6) + c[i:]
windows, out = json.load(open(sys.argv[1])), open(sys.argv[2], "a")
got = empty = 0
for date, contract, sec in windows:
    data = urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", schema="cbbo-1s", stype_in="raw_symbol", encoding="csv",
                                       pretty_px="true", pretty_ts="true", symbols=pad(contract),
                                       start=utc(date, sec - 2), end=utc(date, sec + 14))).encode()
    req = urllib.request.Request("https://hist.databento.com/v0/timeseries.get_range", data=data, headers={"Authorization": auth})
    for tries in range(4):
        try: text = urllib.request.urlopen(req, timeout=120).read().decode(); break
        except Exception:
            if tries == 3: raise
            time.sleep(5 * (tries + 1))
    rows = [[sec_of(r["ts_recv"]) - 1, float(r["bid_px_00"]), float(r["ask_px_00"])] for r in csv.DictReader(io.StringIO(text))
            if r["bid_px_00"] and r["ask_px_00"] and float(r["bid_px_00"]) > 0 and float(r["ask_px_00"]) > 0]
    if rows: got += 1
    else: empty += 1
    out.write(json.dumps([date, contract, sec - 2, sec + 14, rows]) + "\n")
print(f"{len(windows)} windows: {got} with a book, {empty} empty (no two-sided quote)")
