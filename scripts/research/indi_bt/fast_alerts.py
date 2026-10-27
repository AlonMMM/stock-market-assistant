"""The fast volume alert (stock-market-assistant #182, scripts/research/fast_volume.py: rule R60 at 4x, a rolling
60-second window checked every 10 s on 10-second SIP bars, fresh crossings, 120-minute cooldown) as the Volume bot's
alert, for leg_seconds.py (the user, 2026-10-27: "test this fast alert instead of our current alert. all stay the
same - just the first alert is changed"). Alerts 09:40-13:00 (zero5.FIRST..LAST), 10-second bars 2025-10-23 on.
  python3 fast_alerts.py SYM,SYM,...   (from the app repo root) -> sec_cache/fast_alerts.json
"""
import json, os, sqlite3, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
APP = os.getcwd()
sys.path.insert(0, os.environ.get("FV_DIR", os.path.join(APP, "scripts", "research")))   # fast_volume.py is on main
import fast_volume as FV
from zero5 import FIRST, LAST

RULE, K = "R60", 4


def alerts(sym, dates, opens, full):
    db = sqlite3.connect(f"file:{os.path.join(APP, FV.DB)}?mode=ro", uri=True)
    V, C, O = FV.load(db, sym, opens)
    keep = full & (V.sum(axis=1) > 0)
    V, C, O = V[keep], C[keep], O[keep]
    ds = [dates[i] for i in np.flatnonzero(keep)]
    if len(ds) <= FV.DAYS: return []
    Cf = FV.ffill(C)
    sig, ev, br, dirn = FV.rule_signals(V, C, O, Cf, FV.RULES[RULE], K)
    out = []
    for d, t in FV.fire(sig, ev, br):
        if d < FV.DAYS: continue
        m = int(t) // 6
        if not FIRST <= m <= LAST: continue
        out.append(dict(sym=sym, date=ds[d], slot=int(t), sec=(int(t) + 1) * 10, dir=int(dirn[d, t]), price=float(Cf[d, t])))
    return out


if __name__ == "__main__":
    os.chdir(APP)
    db = sqlite3.connect(f"file:{FV.DB}?mode=ro", uri=True)
    dates, opens, full = FV.sessions(db)
    res = []
    for s in sys.argv[1].split(","):
        a = alerts(s, dates, opens, full); res += a; print(s, len(a), flush=True)
    json.dump(res, open(os.path.join(HERE, "sec_cache", "fast_alerts.json"), "w"))
