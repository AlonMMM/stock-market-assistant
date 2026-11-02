# Temporary: buys a whole session of OPRA cbbo-1m for each contract-day the shock tests lack at the sale (approved by
# the user 2026-11-02), labelled as dbx_fetch.fetch does (the ts_recv minute from the open); with --quote, the cost only.
#   node --env-file=.env scripts/research/indi_bt/run.mjs .dbx_minutes.py <days.json> <out.jsonl> [--quote]
import base64, csv, io, json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
auth = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
def utc(date, minute):
    h, m = divmod(570 + minute, 60)
    return datetime.fromisoformat(f"{date}T{h:02d}:{m:02d}").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M")
def pad(c):
    i = next(k for k, ch in enumerate(c) if ch.isdigit())
    return c[:i].ljust(6) + c[i:]
days, out, quote = json.load(open(sys.argv[1])), sys.argv[2], "--quote" in sys.argv
total = 0.0
for date, contract in days:
    q = dict(dataset="OPRA.PILLAR", schema="cbbo-1m", stype_in="raw_symbol", symbols=pad(contract), start=utc(date, -1), end=utc(date, 391))
    if quote:
        req = urllib.request.Request(f"https://hist.databento.com/v0/metadata.get_cost?{urllib.parse.urlencode(q)}", headers={"Authorization": auth})
        total += float(urllib.request.urlopen(req, timeout=60).read().decode()); continue
    data = urllib.parse.urlencode(dict(q, encoding="csv", pretty_px="true", pretty_ts="true")).encode()
    req = urllib.request.Request("https://hist.databento.com/v0/timeseries.get_range", data=data, headers={"Authorization": auth})
    for tries in range(4):
        try: text = urllib.request.urlopen(req, timeout=300).read().decode(); break
        except Exception:
            if tries == 3: raise
            time.sleep(10 * (tries + 1))
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        if not (r["bid_px_00"] and r["ask_px_00"]): continue
        t = datetime.fromisoformat(r["ts_recv"].replace("Z", "+00:00")).astimezone(NY)
        rows.append([t.hour * 60 + t.minute - 570, float(r["bid_px_00"]), float(r["ask_px_00"])])
    with open(out, "a") as f: f.write(json.dumps([date, contract, rows]) + "\n")
print(f"{len(days)} contract-days: " + (f"${total:.4f}" if quote else "bought"))
