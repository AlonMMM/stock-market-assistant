"""The stock's 60-second volume multiple (rolling window / its 20-session median at that time of day, or today's pace,
the larger: the shock rule's own measure) for every 10-second slot from each shock alert to 400 s after it.
For the buy retry (the user, 2026-10-29: "keep trying for 1 minute if the stock keeps big volume").
  python3 shock_volmult.py <events.json> <out.json>      (from the app repo root)"""
import datetime as dt, json, os, sqlite3, sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from zoneinfo import ZoneInfo
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../../sma-fast-volume/scripts/research"))
import fast_volume as fv  # noqa: E402
import early_rules as er  # noqa: E402

NY = ZoneInfo("America/New_York")
DB = "data/local/bars-10s.sqlite"


def one(args):
    sym, want = args
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    days = [r[0] for r in db.execute("select date from symbol_days where symbol = ? order by date", (sym,))]
    opens = np.array([int(dt.datetime.fromisoformat(d + "T09:30").replace(tzinfo=NY).timestamp()) for d in days], dtype=np.int64)
    m = er.load(db, sym, opens)
    r = fv.RULES["R60"]
    win = fv.window_sum(m["V"], r["w"])
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = win / fv.past_median(win)
    pace = fv.pace_ratio(m["V"], win, r["w"], r["step"])
    mult = np.fmax(np.nan_to_num(ratio, nan=0), np.nan_to_num(pace, nan=0))
    out = {}
    for date, sec0 in want:
        if date not in days: continue
        d = days.index(date); s0 = sec0 // 10 - 1
        out[f"{sym}|{date}|{sec0}"] = [round(float(x), 2) for x in mult[d, s0:s0 + 41]]
    return out


def main():
    ev = json.load(open(sys.argv[1]))
    by = defaultdict(list)
    for e in ev: by[e["sym"]].append((e["date"], e["sec0"]))
    with ProcessPoolExecutor(8) as ex: res = list(ex.map(one, by.items()))
    out = {k: v for r in res for k, v in r.items()}
    json.dump(out, open(sys.argv[2], "w")); print(len(out), "shocks")


if __name__ == "__main__": main()
