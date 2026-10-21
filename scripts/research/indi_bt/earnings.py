"""Earnings dates for the universe, from the public Nasdaq earnings calendar (one request per weekday, cached).

  python3 earnings.py [start] [end]      (from the repo root) -> data/local/x/bt/earnings.json
{sym: [[date, time], ...]}; time is time-pre-market / time-after-hours / time-not-supplied.
"""
import datetime as dt, json, os, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P

D = "data/local/x/bt/earn"


def day(d):
    f = f"{D}/{d}.json"
    if os.path.exists(f): return json.load(open(f))
    req = urllib.request.Request(f"https://api.nasdaq.com/api/calendar/earnings?date={d}", headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    for a in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r: j = json.load(r)
            break
        except Exception:
            time.sleep(3 * (a + 1))
    else:
        raise RuntimeError("nasdaq keeps failing " + d)
    rows = [[x["symbol"], x.get("time", "")] for x in ((j.get("data") or {}).get("rows") or [])]
    json.dump(rows, open(f, "w")); time.sleep(0.25)
    return rows


def main(a="2022-12-01", b="2026-12-31"):
    want = set(P["universe_wide"]) | set(P["universe"]); out = {}
    d = dt.date.fromisoformat(a)
    while d.isoformat() <= b:
        if d.weekday() < 5:
            for s, t in day(d.isoformat()):
                if s in want: out.setdefault(s, []).append([d.isoformat(), t])
        d += dt.timedelta(days=1)
    json.dump(out, open("data/local/x/bt/earnings.json", "w"), indent=0)
    print({s: len(v) for s, v in sorted(out.items()) if s in P["universe"]})


if __name__ == "__main__":
    main(*sys.argv[1:3])
