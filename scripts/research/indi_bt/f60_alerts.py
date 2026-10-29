"""F60x2 alerts over any span (the user, 2026-10-29: "do the test for 3 years"): the early-rules study's rule (sma-fast-volume
scripts/research fast_volume.py R60 with K=2: a rolling 60-second window checked every 10 s, volume >= 2x its 20-session
median for that window at that time of day or 2x today's pace, |move| >= 3x its median and >= 0.29%, >= 3,333 shares, the
direction check), fresh crossings, a 30-minute cooldown (early_rules.py), 09:40-13:00. From data/local/bars-10s.sqlite.
Writes the early-alert shape leg_seconds.py reads (SEC_ALERT=fast): sym, date, slot, sec (the slot's end), price.
  python3 f60_alerts.py <out.json> <from> <to> SYM,SYM,...      (from the app repo root)"""
import datetime as dt, json, os, sqlite3, sys
from concurrent.futures import ProcessPoolExecutor
from zoneinfo import ZoneInfo
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../../sma-fast-volume/scripts/research"))
import fast_volume as fv  # noqa: E402
import early_rules as er  # noqa: E402

NY = ZoneInfo("America/New_York")
FIRST, LAST = 59, 1259   # 10-s slots ending 09:40:00 .. 13:00:00
DB = "data/local/bars-10s.sqlite"


def one(args):
    sym, lo, hi = args
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    days = [r[0] for r in db.execute("select date from symbol_days where symbol = ? order by date", (sym,))] if db.execute(
        "select name from sqlite_master where name='symbol_days'").fetchone() else []
    if not days:
        days = sorted({r[0] for r in db.execute("select date(start, 'unixepoch', '-5 hours') from bars where symbol = ?", (sym,))})
    days = [d for d in days if d <= hi]
    if len(days) <= fv.DAYS: return []
    opens = np.array([int(dt.datetime.fromisoformat(d + "T09:30").replace(tzinfo=NY).timestamp()) for d in days], dtype=np.int64)
    m = er.load(db, sym, opens)
    m["Craw"] = m["C"]; m["C"] = fv.ffill(m["C"])
    sig, _, _, _ = fv.rule_signals(m["V"], m["Craw"], m["O"], m["C"], fv.RULES["R60"], 2)
    out = []
    for d, t in er.fire(sig, er.COOLDOWN):
        if days[d] < lo or not FIRST <= t <= LAST or d < fv.DAYS: continue
        price = m["C"][d, t]
        if not np.isfinite(price): continue
        out.append(dict(sym=sym, date=days[d], slot=int(t), sec=int((t + 1) * 10), price=round(float(price), 4)))
    return out


def main():
    out, lo, hi, syms = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(",")
    with ProcessPoolExecutor(8) as ex: res = list(ex.map(one, [(s, lo, hi) for s in syms]))
    alerts = [a for r in res for a in r]
    json.dump(alerts, open(out, "w"))
    print(len(alerts), "alerts on", len({(a["sym"], a["date"]) for a in alerts}), "stock-days")


if __name__ == "__main__": main()
