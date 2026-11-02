# Quote only (metadata.get_cost, no data bought): the OPRA cbbo-1s windows the shock tests lack, one per contract
# and buy second, [second - 2, second + 82] as leg_seconds.fetch_opt2 reads them. The key from the environment.
#   node --env-file=.env scripts/research/indi_bt/run.mjs <this file> <windows.json>
import base64, json, os, sys, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
auth = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
def utc(date, sec):
    h, r = divmod(34200 + sec, 3600); m, s = divmod(r, 60)
    return datetime.fromisoformat(f"{date}T{h:02d}:{m:02d}:{s:02d}").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
def pad(c):
    i = next(k for k, ch in enumerate(c) if ch.isdigit())
    return c[:i].ljust(6) + c[i:]
total, n = 0.0, 0
for date, contract, sec in json.load(open(sys.argv[1])):
    q = urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", schema="cbbo-1s", stype_in="raw_symbol", symbols=pad(contract),
                                    start=utc(date, sec - 2), end=utc(date, sec + 82)))
    req = urllib.request.Request(f"https://hist.databento.com/v0/metadata.get_cost?{q}", headers={"Authorization": auth})
    total += float(urllib.request.urlopen(req, timeout=60).read().decode()); n += 1
print(f"{n} windows: ${total:.4f}")
