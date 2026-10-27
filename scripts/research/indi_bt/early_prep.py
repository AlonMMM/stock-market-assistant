"""The early-sign alerts (stock-market-assistant data/local/early_alerts.csv, docs/research/early-alerts.md on branch
research/early-rules) as the Volume bot's alert, for leg_seconds.py with SEC_ALERT=fast SEC_ALERT_FILE=early_<slug>.json.
Top 50 of strangle_rank.json that the file covers, 09:40-13:00 (zero5.FIRST..LAST), the file's own cooldowns. The price
is the alert slot's 10-second close (what was known at time_ny); the alert second is the slot's end.
  python3 early_prep.py "A,3 steady + 6 range,6 range + 4 no block"   (from the app repo root)
"""
import csv, json, os, re, sqlite3, sys
from datetime import datetime
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from zero5 import FIRST, LAST
NY = ZoneInfo("America/New_York")


def slug(rule): return re.sub(r"[^a-z0-9]+", "_", rule.lower()).strip("_")


if __name__ == "__main__":
    rules = sys.argv[1].split(",")
    top = set(json.load(open(os.path.join(HERE, "strangle_rank.json")))[:50])
    db = sqlite3.connect("file:data/local/bars-10s.sqlite?mode=ro", uri=True)
    out = {r: [] for r in rules}
    for a in csv.DictReader(open("data/local/early_alerts.csv")):
        if a["rule"] not in out or a["symbol"] not in top: continue
        slot = int(a["slot"])
        if not FIRST <= slot // 6 <= LAST: continue
        open_ts = int(datetime.fromisoformat(a["date"] + "T09:30:00").replace(tzinfo=NY).timestamp())
        row = db.execute("select close from bars where symbol = ? and start <= ? and start >= ? order by start desc limit 1",
                         (a["symbol"], open_ts + slot * 10, open_ts)).fetchone()
        if not row: continue
        out[a["rule"]].append(dict(sym=a["symbol"], date=a["date"], slot=slot, sec=(slot + 1) * 10, price=row[0], period=a["period"]))
    for r, xs in out.items():
        json.dump(xs, open(os.path.join(HERE, "sec_cache", f"early_{slug(r)}.json"), "w"))
        print(r, "->", f"early_{slug(r)}.json", len(xs), "alerts,", len({x["sym"] for x in xs}), "names", flush=True)
