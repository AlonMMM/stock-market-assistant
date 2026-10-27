"""Pre-filter an early alert file (e.g. F60x2, 20K alerts) with the winning Volume rule before any Databento fetch:
from the local 10-second bars, does the stock touch a side line (0.25 x S30 from the alert price) within MAX_S seconds,
and is the burst (the alert price against the close that ended 3 minutes before, the side's way, in S30) >= AM_MIN?
A 10-second bar's high / low counts as a touch, so this keeps every alert the exact 1-second cross could keep.
  python3 f60_prefilter.py <early file in sec_cache> <out file in sec_cache>   (from the app repo root)
  env: PF_MAX_S (20), PF_AM_MIN (1.1)"""
import datetime as dt, json, os, sqlite3, sys
from zoneinfo import ZoneInfo
os.environ.setdefault("BT_VARIANT", "v2")
import leg_1dte as L1
import leg_twice as TW
from levels import ctx
from store import day

HERE = os.path.dirname(os.path.abspath(__file__))
NY = ZoneInfo("America/New_York")
TEN_DB = os.environ.get("BT_10S_DB", "data/local/bars-10s.sqlite")
MAX_S = int(os.environ.get("PF_MAX_S", "20"))
AM_MIN = float(os.environ.get("PF_AM_MIN", "1.1"))
db = sqlite3.connect(f"file:{TEN_DB}?mode=ro", uri=True)


def slots(sym, date, a, z):
    """The 10-second bars starting in [a, z) seconds after 9:30: (start second, high, low)."""
    d = dt.date.fromisoformat(date)
    t0 = int(dt.datetime(d.year, d.month, d.day, 9, 30, tzinfo=NY).timestamp())
    return [(s - t0, h, l) for s, h, l in db.execute("SELECT start, high, low FROM bars WHERE symbol=? AND start>=? AND start<? ORDER BY start",
                                                     (sym, t0 + a, t0 + z))]


def main():
    src, out_name = sys.argv[1], sys.argv[2]
    alerts = json.load(open(os.path.join(HERE, "sec_cache", src)))
    top = set(json.load(open(os.path.join(HERE, "strangle_rank.json")))[:50])
    n = dict(alerts=len(alerts), no_expiry=0, no_s30=0, no_bars=0, no_cross=0, burst_low=0, kept=0)
    keep, minutes = [], {}
    for a in alerts:
        if a["sym"] not in top or a["date"] not in TW.CAL: continue
        if not L1.kind_of(a["sym"], a["date"]): n["no_expiry"] += 1; continue
        x = ctx(a["sym"], a["date"])
        if not x or not x.get("sd"): n["no_s30"] += 1; continue
        u, p0, sec = x["sd"], a["price"], a["sec"]
        bars = slots(a["sym"], a["date"], sec, sec + MAX_S)
        if not bars: n["no_bars"] += 1; continue
        up, dn = p0 * (1 + TW.K * u), p0 * (1 - TW.K * u)
        sides = []
        for s, h, l in bars:   # the first bar that touches a line; both lines in one bar keeps both sides
            if h >= up: sides.append("C")
            if l <= dn: sides.append("P")
            if sides: break
        if not sides: n["no_cross"] += 1; continue
        k = (a["sym"], a["date"])
        if k not in minutes: minutes[k] = {b[0]: b for b in day(*k)}
        m = minutes[k].get((sec - 180) // 60 - 1)
        if not m: n["no_bars"] += 1; continue
        ams = {sd: (1 if sd == "C" else -1) * (p0 / m[4] - 1) / u for sd in sides}
        if max(ams.values()) < AM_MIN: n["burst_low"] += 1; continue
        n["kept"] += 1
        keep.append(dict(a, pf_sides="".join(sides), pf_burst=round(max(ams.values()), 2)))
    json.dump(keep, open(os.path.join(HERE, "sec_cache", out_name), "w"))
    days = {(k["date"], k["sym"]) for k in keep}
    print(json.dumps(n), f"stock-days {len(days)}")


if __name__ == "__main__": main()
