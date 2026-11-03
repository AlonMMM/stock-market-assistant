"""The shock list (f60_alerts.py F60_K=15, 09:40-15:30) with a lower bar, the day's-pace gate or a smoothed usual, over 3
years, for leg_seconds.py (the user, 2026-11-03: "check on 3 year", after the live-code year of 2026-11-03 in
volume-bot.md: 10x + 3x / 5x the pace and the smoothed usual "+-2.5 / +-5 min" were run on one year only). The same
rule as the app's scratch .shock-recompute.ts SET2 / SET4: the 60-second window (fast_volume R60) >= K x its 20-session
median for that time of day OR K x today's pace, |move| >= 3x its median and >= 0.29%, >= 3,333 shares, the direction
check, fresh crossings, a 30-minute cooldown; plus
  GATE=g    the window also >= g x today's pace (fast.ts fastState, the zone from minute 30); no pace yet (before ~10:16)
            fails, as the recompute's paceAt (0 before the pace exists)
  SMOOTH=s  each prior day's 60-second volume averaged over +-s 10-second slots (the windows that exist), then the
            20-session median; the spike itself stays 60 s
  EDGE=1    the smoothing narrows near 09:40 and 15:30 (half-width min(s, slots from 09:40, slots to 15:30)), so the open's
            fast fall is not blurred into 09:40 (the user, 2026-11-03: "we can't look on a specific minute"; K set so the
            smoothed rule fires about as many shocks as the live one, not a higher bar by the back door)
  python3 f60_variants.py <out.json> <from> <to> SYM,SYM,... K GATE SMOOTH [EDGE]      (from the app repo root)
  e.g. 10 3 0 = 10x + 3x the pace; 15 3 15 = smoothed +-2.5 min + 3x; 15 0 0 = the live rule (reproduces shock15.json)"""
import datetime as dt, json, os, sqlite3, sys
from concurrent.futures import ProcessPoolExecutor
from zoneinfo import ZoneInfo
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../../sma-fast-volume/scripts/research"))
import fast_volume as fv  # noqa: E402
import early_rules as er  # noqa: E402

NY = ZoneInfo("America/New_York")
FIRST, LAST = 59, 2159   # 10-s slots ending 09:40:00 .. 15:30:00
DB = "data/local/bars-10s.sqlite"
W = 6


def smoothed(win, s, edge=False):
    """Each slot's window averaged over +-s slots, over the windows that exist (NaN ones left out)."""
    ok = ~np.isnan(win)
    v = np.where(ok, win, 0.0)
    pad = lambda x: np.concatenate([np.zeros((x.shape[0], 1)), np.cumsum(x, axis=1)], axis=1)
    cv, ck = pad(v), pad(ok.astype(float))
    n = win.shape[1]
    t = np.arange(n)
    h = np.minimum(s, np.maximum(0, np.minimum(t - FIRST, LAST - t))) if edge else np.full(n, s)
    lo, hi = np.clip(t - h, 0, n), np.clip(t + h + 1, 0, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = (cv[:, hi] - cv[:, lo]) / (ck[:, hi] - ck[:, lo])
    return np.where(ok, out, np.nan)


def signals(V, Craw, Cf, K, gate, smooth, edge):
    share_floor, floor = 10000 * W / 18, 0.5 * np.sqrt(W / 18)
    win = fv.window_sum(V, W)
    move = (Cf / fv.shifted(Cf, W) - 1) * 100
    expected = fv.past_median(smoothed(win, smooth, edge) if smooth else win)
    exp_move = fv.past_median(np.abs(move))
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = win / expected
    pace = np.nan_to_num(fv.pace_ratio(V, win, W, 1), nan=0)
    vol_ok = (np.nan_to_num(ratio, nan=0) >= K) | (pace >= K)
    if gate: vol_ok &= pace >= gate
    am = np.abs(move)
    last = Cf - fv.shifted(Cf, 1)
    dir_ok = ((move > 0) & (last >= 0)) | ((move < 0) & (last <= 0))
    return vol_ok & (am >= 3 * exp_move) & (am >= floor) & dir_ok & (win >= share_floor) & ~np.isnan(expected)


def one(args):
    sym, lo, hi, K, gate, smooth, edge = args
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
    sig = signals(m["V"], m["Craw"], m["C"], K, gate, smooth, edge)
    out = []
    for d, t in er.fire(sig, er.COOLDOWN):
        if days[d] < lo or not FIRST <= t <= LAST or d < fv.DAYS: continue
        price = m["C"][d, t]
        if not np.isfinite(price): continue
        out.append(dict(sym=sym, date=days[d], slot=int(t), sec=int((t + 1) * 10), price=round(float(price), 4)))
    return out


def main():
    out, lo, hi, syms = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(",")
    K, gate, smooth = float(sys.argv[5]), float(sys.argv[6]), int(sys.argv[7])
    edge = len(sys.argv) > 8 and sys.argv[8] == "1"
    with ProcessPoolExecutor(6) as ex: res = list(ex.map(one, [(s, lo, hi, K, gate, smooth, edge) for s in syms]))
    alerts = [a for r in res for a in r]
    json.dump(alerts, open(out, "w"))
    print(len(alerts), "alerts on", len({(a["sym"], a["date"]) for a in alerts}), "stock-days")


if __name__ == "__main__": main()
