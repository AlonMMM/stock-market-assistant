"""Fast volume alerts: how much earlier can a burst be caught, and at what cost
in quality? (user, 2026-10-27: "know the fastest as possible that big volume is
here"; "only 1 10-sec bar can be very noisy").

Every rule runs on the same data: data/local/bars-10s.sqlite (SIP trades rolled
into 10-second bars, regular hours, Alpaca's condition rules). A minute rolled
up from it matches Alpaca's minute bar, so rule A is today's live rule.

Rules (all: volume >= K x its 20-session median for the same window at the
same time of day, or >= K x today's pace mid-session; |move| >= 3 x its
20-session median and >= a floor; direction check; >= a share floor; alert on a
fresh crossing; 120-minute cooldown):
  A   today: closed 1-minute bars, 3-minute window, checked at minute ends
      (rvol-v6, regular hours only; checked against the TS evaluator)
  A1  closed 1-minute bars, 1-minute window (the "one loud minute" quick fix)
  R180/R60/R30  rolling 180/60/30-second window, checked every 10 s
  P20 20 s, both 10-s slots each >= K x their own median
The share floor scales with the window (10,000 per 3 minutes); the move floor
0.5% scales with sqrt(window / 3 min) (a random walk's typical move).

Score (as scripts/research/alert-study.ts): ref = the close when the alert is
known; the excursion is the largest |close / ref - 1| over the next 30 minutes
(10-s closes); its unit is the median excursion at the same 10-s slot over the
previous 20 sessions; a hit is >= 2 units. Alerts whose 30 minutes would cross
the close are not scored. Lift: hits / the hit rate of every 10-s slot of the
same symbol in the same 15-minute bucket (tod) or on the same date (day).
CIs resample dates.

Splits: tune 2025-11-21 .. 2026-05-29 (the first 20 sessions are baseline);
check 2026-06-01 .. 2026-10-22 (run once, after the rules are frozen).

  python3 -I scripts/research/fast_volume.py --split tune [--sweep] [--symbols A,B]
  python3 -I scripts/research/fast_volume.py --dump-minutes AAPL  (for the TS check)
"""

import argparse
import json
import sqlite3
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d

DB = "data/local/bars-10s.sqlite"
TICKERS = "data/local/backtest-tickers.txt"
NY = ZoneInfo("America/New_York")
S = 2340  # 10-s slots in a regular session
DAYS = 20
FWD = 180  # 30 minutes of 10-s slots
COOLDOWN = 720  # 120 minutes of 10-s slots
TUNE = ("2025-11-21", "2026-05-29")
CHECK = ("2026-06-01", "2026-10-22")


def sessions(db):
    rows = db.execute("select distinct date from symbol_days order by date").fetchall()
    dates = [r[0] for r in rows]
    opens = []
    for d in dates:
        y, m, dd = map(int, d.split("-"))
        opens.append(int(datetime(y, m, dd, 9, 30, tzinfo=NY).timestamp()))
    opens = np.array(opens, dtype=np.int64)
    # Early closes (13:00) carry no bars after 13:00: drop those days.
    last = dict(
        db.execute(
            "select (start - 0) / 86400, max(start) from bars where symbol = 'AAPL' group by start / 86400"
        ).fetchall()
    )
    full = []
    for i, o in enumerate(opens):
        end = last.get(int(o) // 86400)
        full.append(end is not None and end - o >= S * 10 - 600)
    return dates, opens, np.array(full)


def load(db, symbol, opens):
    rows = np.array(
        db.execute(
            "select start, open, close, volume from bars where symbol = ? order by start",
            (symbol,),
        ).fetchall(),
        dtype=np.float64,
    )
    n = len(opens)
    V = np.zeros((n, S))
    C = np.full((n, S), np.nan)
    O = np.full((n, S), np.nan)
    if len(rows) == 0:
        return V, C, O
    start = rows[:, 0].astype(np.int64)
    di = np.searchsorted(opens, start, side="right") - 1
    slot = (start - opens[np.clip(di, 0, None)]) // 10
    ok = (di >= 0) & (slot >= 0) & (slot < S)
    di, slot, rows = di[ok], slot[ok], rows[ok]
    V[di, slot] = rows[:, 3]
    C[di, slot] = rows[:, 2]
    O[di, slot] = rows[:, 1]
    return V, C, O


def ffill(C):
    out = C.copy()
    for d in range(out.shape[0]):
        row = out[d]
        idx = np.where(~np.isnan(row), np.arange(S), 0)
        np.maximum.accumulate(idx, out=idx)
        row[:] = row[idx]
        first = np.flatnonzero(~np.isnan(row))
        if len(first):
            row[: first[0]] = row[first[0]]
    return out


def past_median(X, days=DAYS):
    """Median over the previous `days` sessions, same slot; NaN if any is NaN."""
    out = np.full_like(X, np.nan)
    for d in range(days, X.shape[0]):
        out[d] = np.median(X[d - days : d], axis=0)
    return out


def window_sum(X, w):
    """Sum of slots t-w+1..t within the day; NaN before the window fits."""
    c = np.cumsum(X, axis=1)
    out = np.full_like(X, np.nan)
    out[:, w - 1] = c[:, w - 1]
    out[:, w:] = c[:, w:] - c[:, :-w]
    return out


def shifted(X, k):
    out = np.full_like(X, np.nan)
    out[:, k:] = X[:, :-k]
    return out


# Pace zone: minutes 30..359 after the open (live: end minute > 600 and
# <= 930 New York minutes), in 10-s slots.
PACE_LO, PACE_HI = 30 * 6, 360 * 6


def pace_ratio(Vs, win, w, step):
    """Window volume / (today's average slot volume in the pace zone before the
    window x w). Needs 15 minutes of zone before the window; the window must lie
    in the zone."""
    zone = np.zeros(S, bool)
    zone[PACE_LO:PACE_HI] = True
    zv = np.where(zone, Vs, 0.0)
    cum = np.cumsum(zv, axis=1)
    cnt = np.cumsum(np.broadcast_to(zone, Vs.shape), axis=1).astype(float)
    t = np.arange(S)
    before = t - w  # last slot before the window
    ok = (before >= PACE_LO + 15 * 6 - 1) & (t < PACE_HI) & (before >= 0)
    out = np.full_like(Vs, np.nan)
    b = np.clip(before, 0, None)
    pv = cum[:, b]
    pc = cnt[:, b]
    avg = np.where(pc > 0, pv / np.maximum(pc, 1), np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        out[:, ok] = (win / (avg * w))[:, ok]
    out[out == np.inf] = np.nan
    return out


def rule_signals(V, C, O, Cf, rule, K):
    """Boolean matrix: the rule's state is true at slot t (evaluated slots only)."""
    kind, w, step = rule["kind"], rule["w"], rule["step"]
    share_floor = 10000 * w / 18
    floor = 0.5 * np.sqrt(w / 18)
    if kind == "closed":
        # Closed 1-minute bars: a minute exists when it has volume.
        n = V.shape[0]
        Vm = V.reshape(n, 390, 6).sum(axis=2)
        Cm = Cf.reshape(n, 390, 6)[:, :, 5]
        Om = np.full((n, 390), np.nan)
        Or = O.reshape(n, 390, 6)
        for k in range(5, -1, -1):  # first traded slot's open
            Om = np.where(np.isnan(Or[:, :, k]), Om, Or[:, :, k])
        exists = Vm > 0
        mw = w // 6
        win = window_sum(Vm, mw)
        anchor = shifted(Cm, mw)
        contiguous = window_sum(exists.astype(float), mw + 1) == mw + 1
        win = np.where(contiguous, win, np.nan)
        move = (Cm / anchor - 1) * 100
        move = np.where(contiguous, move, np.nan)
        expected = past_median(win)
        exp_move = past_median(np.abs(move))
        with np.errstate(divide="ignore", invalid="ignore"):
            ratio = win / expected
        # Pace on minute bars.
        zone = np.zeros(390, bool)
        zone[30:360] = True
        zv = np.where(zone & exists, Vm, 0.0)
        cum = np.cumsum(zv, axis=1)
        cnt = np.cumsum(zone & exists, axis=1).astype(float)
        m = np.arange(390)
        b = m - mw
        okp = (b >= 0) & zone & np.roll(zone, mw - 1) & (m - mw + 1 >= 30)
        bb = np.clip(b, 0, None)
        pc = cnt[:, bb]
        pv = cum[:, bb]
        with np.errstate(divide="ignore", invalid="ignore"):
            pace = win / (pv / pc * mw)
        pace = np.where(okp[None, :] & (pc >= 15) & (pv > 0), pace, np.nan)
        prev = shifted(Cm, 1)
        up = (Cm > prev) & (Cm > Om)
        down = (Cm < prev) & (Cm < Om)
        vol_ok = (np.nan_to_num(ratio, nan=0) >= K) | (np.nan_to_num(pace, nan=0) >= K)
        am = np.abs(move)
        move_ok = (am >= 3 * exp_move) & (am >= floor)
        # Live checks the last candle only, not that it agrees with the move.
        dir_ok = up | down
        sig_m = vol_ok & move_ok & dir_ok & (win >= share_floor) & ~np.isnan(expected)
        sig = np.zeros(V.shape, bool)
        sig[:, 5::6] = sig_m
        broken = np.zeros(V.shape, bool)  # a missing minute resets "above"
        broken[:, 5::6] = ~contiguous
        evaluated = np.zeros(V.shape, bool)
        evaluated[:, 5::6] = True
        dirn = np.zeros(V.shape, np.int8)
        dirn[:, 5::6] = np.where(up, 1, -1)
        return sig, evaluated, broken, dirn
    win = window_sum(V, w)
    anchor = shifted(Cf, w)
    move = (Cf / anchor - 1) * 100
    expected = past_median(win)
    exp_move = past_median(np.abs(move))
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = win / expected
    pace = pace_ratio(V, win, w, step)
    vol_ok = (np.nan_to_num(ratio, nan=0) >= K) | (np.nan_to_num(pace, nan=0) >= K)
    if kind == "pair":
        exp1 = past_median(V)
        with np.errstate(divide="ignore", invalid="ignore"):
            r1 = np.nan_to_num(V / exp1, nan=0, posinf=1e9)
        vol_ok = (r1 >= K) & (shifted(r1, 1) >= K)
    am = np.abs(move)
    move_ok = (am >= 3 * exp_move) & (am >= floor)
    last = Cf - shifted(Cf, 1)
    dir_ok = ((move > 0) & (last >= 0)) | ((move < 0) & (last <= 0))
    sig = vol_ok & move_ok & dir_ok & (win >= share_floor) & ~np.isnan(expected)
    evaluated = np.ones(V.shape, bool)
    broken = np.zeros(V.shape, bool)
    dirn = np.where(move > 0, 1, -1).astype(np.int8)
    return sig, evaluated, broken, dirn


def fire(sig, evaluated, broken):
    """Fresh crossings outside a 120-minute cooldown (the cooldown carries
    across days by clock time; sessions are 2340 slots apart, so a day's
    alerts never block the next day's)."""
    alerts = []
    n = sig.shape[0]
    for d in range(n):
        above = False
        last = -(10**9)
        cols = np.flatnonzero(evaluated[d])
        s_row, b_row = sig[d], broken[d]
        for t in cols:
            if b_row[t]:
                above = False
            s = s_row[t]
            if s and not above and t - last >= COOLDOWN:
                alerts.append((d, t))
                last = t
            above = s
    return alerts


RULES = {
    "A": dict(kind="closed", w=18, step=6),
    "A1": dict(kind="closed", w=6, step=6),
    "R180": dict(kind="roll", w=18, step=1),
    "R60": dict(kind="roll", w=6, step=1),
    "R30": dict(kind="roll", w=3, step=1),
    "P20": dict(kind="pair", w=2, step=1),
}


def score_matrices(Cf):
    hi = maximum_filter1d(Cf, size=FWD, axis=1, origin=-(FWD // 2))
    lo = minimum_filter1d(Cf, size=FWD, axis=1, origin=-(FWD // 2))
    # Window t+1..t+FWD: shift by one slot.
    hi = np.concatenate([hi[:, 1:], np.full((Cf.shape[0], 1), np.nan)], axis=1)
    lo = np.concatenate([lo[:, 1:], np.full((Cf.shape[0], 1), np.nan)], axis=1)
    exc = np.maximum(hi / Cf - 1, 1 - lo / Cf)
    exc[:, S - FWD :] = np.nan  # would cross the close
    unit = past_median(exc)
    return exc, unit


def work(job):
    symbol, opens, full, dates, split, combos = job
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    V, C, O = load(db, symbol, opens)
    keep = full & (V.sum(axis=1) > 0)
    V, C, O = V[keep], C[keep], O[keep]
    ds = [dates[i] for i in np.flatnonzero(keep)]
    if len(ds) <= DAYS:
        return symbol, [], {}
    Cf = ffill(C)
    exc, unit = score_matrices(Cf)
    lo, hi_ = split
    in_split = np.array([lo <= d <= hi_ for d in ds])
    in_split[:DAYS] = False
    scored = ~np.isnan(exc) & ~np.isnan(unit) & (unit > 0) & in_split[:, None]
    hit = np.where(scored, exc >= 2 * np.nan_to_num(unit, nan=np.inf), False)
    bucket = np.arange(S) // 90
    tod = {}
    for b in range(26):
        m = scored[:, bucket == b]
        tod[b] = hit[:, bucket == b][m].mean() if m.any() else np.nan
    dayb = np.array(
        [hit[d][scored[d]].mean() if scored[d].any() else np.nan for d in range(len(ds))]
    )
    # Volume in the next 60 s vs its normal (does the burst go on?).
    win6 = window_sum(V, 6)
    med6 = past_median(win6)
    out = []
    for name, K in combos:
        sig, ev, br, dirn = rule_signals(V, C, O, Cf, RULES[name], K)
        sig &= in_split[:, None]
        for d, t in fire(sig, ev, br):
            nxt = t + 6
            go_on = None
            if nxt < S and med6[d, nxt] > 0:
                go_on = float(win6[d, nxt] / med6[d, nxt])
            ok = bool(scored[d, t])
            out.append(
                dict(
                    sym=symbol,
                    rule=name,
                    K=K,
                    date=ds[d],
                    slot=int(t),
                    dir=int(dirn[d, t]),
                    price=float(Cf[d, t]),
                    scored=ok,
                    hit=bool(hit[d, t]) if ok else None,
                    units=float(exc[d, t] / unit[d, t]) if ok else None,
                    unit=float(unit[d, t]) if ok else None,
                    tod=float(tod[int(bucket[t])]) if ok else None,
                    day=float(dayb[d]) if ok else None,
                    goOn=go_on,
                )
            )
    base = dict(
        slots=int(scored.sum()),
        hits=int(hit.sum()),
        days=int(in_split.sum()),
    )
    return symbol, out, base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=["tune", "check"], default="tune")
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--symbols")
    ap.add_argument("--k", help="rule=K,... for the frozen run, e.g. R60=5,R30=6")
    ap.add_argument("--out", default="/dev/stdout")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--dump-minutes")
    a = ap.parse_args()
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    dates, opens, full = sessions(db)
    if a.dump_minutes:
        dump(db, a.dump_minutes, dates, opens, full)
        return
    symbols = a.symbols.split(",") if a.symbols else open(TICKERS).read().split()
    if a.sweep:
        combos = [("A", 4), ("A1", 4), ("A1", 6), ("A1", 8)]
        for r in ("R180", "R60", "R30", "P20"):
            for K in (4, 5, 6, 8, 10, 12):
                combos.append((r, K))
    else:
        combos = [("A", 4), ("A1", 4), ("R180", 4), ("R60", 4), ("R30", 4), ("P20", 4)]
        if a.k:
            for part in a.k.split(","):
                r, k = part.split("=")
                combos.append((r, float(k)))
    split = TUNE if a.split == "tune" else CHECK
    jobs = [(s, opens, full, dates, split, combos) for s in symbols]
    alerts, bases = [], {}
    with ProcessPoolExecutor(a.workers) as ex:
        for i, (sym, out, base) in enumerate(ex.map(work, jobs)):
            alerts.extend(out)
            bases[sym] = base
            print(f"{i + 1}/{len(jobs)} {sym} {len(out)}", file=sys.stderr)
    with open(a.out, "w") as f:
        json.dump(dict(split=a.split, combos=combos, bases=bases, alerts=alerts), f)


def dump(db, symbol, dates, opens, full):
    """Minute bars rolled up from the 10-s bars, for the TS evaluator check."""
    V, C, O = load(db, symbol, opens)
    bars = []
    for d in range(len(dates)):
        if not full[d] or V[d].sum() == 0:
            continue
        for m in range(390):
            sl = slice(m * 6, m * 6 + 6)
            v = V[d, sl]
            if v.sum() <= 0:
                continue
            idx = np.flatnonzero(~np.isnan(C[d, sl]))
            end = int(opens[d]) + (m + 1) * 60
            bars.append(
                dict(
                    ticker=symbol,
                    end=datetime.utcfromtimestamp(end).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                    date=dates[d],
                    minute=571 + m,
                    session="regular",
                    volume=int(v.sum()),
                    open=float(O[d, sl][idx[0]]),
                    close=float(C[d, sl][idx[-1]]),
                )
            )
    json.dump(bars, sys.stdout)


if __name__ == "__main__":
    main()
