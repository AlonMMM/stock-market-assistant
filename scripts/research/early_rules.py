"""Early signs of the biggest moves (user, 2026-10-27: "find early sign for
biggest move, even if sometimes nothing happens"; start on the Favorites).

Scored from the moves' side. A 10-s slot starts a biggest move when, within
the next 60 minutes (or to the close), the price travels >= 4x its unit: the
median of that 60-minute travel at the same slot over the previous 20
sessions. Runs of such slots (gaps <= 5 min merged) form one move; it peaks
where the price is furthest from the run's first slot and starts at the swing
low (high) between them. A move can't start before the previous one's peak.

A rule catches a move when it alerts between 5 minutes before the start and
the peak; "left" is the share of the start-to-peak move still ahead at the
alert (capped at 1); caught early = left >= 0.75. An alert is useful when it
falls between 10 minutes before a move's start and its peak.

Every new rule: fresh crossing, 30-minute cooldown. A = today's live rule
(120-minute cooldown), from fast_volume.py.

  python3 -I scripts/research/early_rules.py --split tune --tickers <file> --out run.json
"""

import argparse
import json
import sqlite3
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d

sys.path.insert(0, "scripts/research")
import fast_volume as fv  # noqa: E402

S, DAYS = fv.S, fv.DAYS
H60 = 360  # 60 minutes of slots
BIG = 4.0  # units of 60-minute travel
MERGE = 30
BEFORE = 30  # a catch may come 5 minutes before the start
USEFUL = 60  # useful alert: up to 10 minutes before the start
COOLDOWN = 180  # 30 minutes


def load(db, symbol, opens):
    rows = np.array(
        db.execute(
            "select start, open, high, low, close, volume, trades from bars where symbol = ? order by start",
            (symbol,),
        ).fetchall(),
        dtype=np.float64,
    )
    n = len(opens)
    out = {k: np.full((n, S), np.nan) for k in ("O", "H", "L", "C")}
    out["V"] = np.zeros((n, S))
    out["N"] = np.zeros((n, S))
    if len(rows):
        start = rows[:, 0].astype(np.int64)
        di = np.searchsorted(opens, start, side="right") - 1
        slot = (start - opens[np.clip(di, 0, None)]) // 10
        ok = (di >= 0) & (slot >= 0) & (slot < S)
        di, slot, rows = di[ok], slot[ok], rows[ok]
        for j, k in enumerate(("O", "H", "L", "C"), start=1):
            out[k][di, slot] = rows[:, j]
        out["V"][di, slot] = rows[:, 5]
        out["N"][di, slot] = rows[:, 6]
    return out


def trailing_max(X, w):
    return maximum_filter1d(X, w, axis=1, origin=(w - 1) // 2, mode="nearest")


def trailing_min(X, w):
    return minimum_filter1d(X, w, axis=1, origin=(w - 1) // 2, mode="nearest")


def forward_travel(Cf, h):
    """Largest |C[s] / C[t] - 1| for s in t+1 .. t+h (to the close)."""
    n = Cf.shape[0]
    hi = np.concatenate([Cf, np.full((n, h), -np.inf)], axis=1)
    lo = np.concatenate([Cf, np.full((n, h), np.inf)], axis=1)
    # Window t .. t+h-1 of the shifted row = slots t+1 .. t+h.
    hi = maximum_filter1d(hi[:, 1:], h, axis=1, origin=-(h // 2))[:, :S]
    lo = minimum_filter1d(lo[:, 1:], h, axis=1, origin=-(h // 2))[:, :S]
    exc = np.maximum(hi / Cf - 1, 1 - lo / Cf)
    exc[:, S - 1] = np.nan
    return exc


def fire(state, cooldown):
    alerts = []
    for d in range(state.shape[0]):
        above, last = False, -(10**9)
        for t in np.flatnonzero(state[d] | np.roll(state[d], 1)):
            s = state[d, t]
            if s and not above and t - last >= cooldown:
                alerts.append((d, int(t)))
                last = t
            above = s
    return alerts


def ratio(x, base):
    with np.errstate(divide="ignore", invalid="ignore"):
        r = x / base
    return np.nan_to_num(r, nan=0.0, posinf=0.0)


def rules(m, spy, beta):
    """State matrices (True = the rule's condition holds) for every rule."""
    V, N, C, O, H, L = m["V"], m["N"], m["C"], m["O"], m["H"], m["L"]
    pm = fv.past_median
    out = {}
    # Today's rule and the plain fast rule, as in fast_volume.py.
    a_sig, a_ev, a_br, _ = fv.rule_signals(V, m["Craw"], O, C, fv.RULES["A"], 4)
    out["A"] = (a_sig, a_ev, a_br)
    for K in (2, 3, 4):
        s, _, _, _ = fv.rule_signals(V, m["Craw"], O, C, fv.RULES["R60"], K)
        out[f"F60x{K}"] = s
    v60 = fv.window_sum(V, 6)
    r60 = ratio(v60, pm(v60))
    mv60 = (C / fv.shifted(C, 6) - 1) * 100
    am60 = np.abs(mv60)
    move60 = (am60 >= 3 * pm(am60)) & (am60 >= 0.29)
    last = C - fv.shifted(C, 1)
    dir60 = ((mv60 > 0) & (last >= 0)) | ((mv60 < 0) & (last <= 0))
    shares60 = v60 >= 10000 / 3
    # 1. Sudden jump: last 30 s vs the 3 minutes before it, today.
    v30 = fv.window_sum(V, 3)
    prev = fv.shifted(fv.window_sum(V, 18), 3)
    mv30 = np.abs((C / fv.shifted(C, 3) - 1) * 100)
    out["1 jump"] = (
        (ratio(v30, prev / 6) >= 5)
        & (ratio(v30, pm(v30)) >= 2)
        & (mv30 >= 2 * pm(mv30))
        & (v30 >= 10000 / 6)
    )
    # 2. Number of trades in 60 s.
    n60 = fv.window_sum(N, 6)
    out["2 trades"] = (ratio(n60, pm(n60)) >= 4) & move60 & dir60
    # 3. Steady: >= 3 of the last 6 slots each >= 3x their own normal.
    loud = (ratio(V, pm(V)) >= 3).astype(float)
    out["3 steady"] = (fv.window_sum(loud, 6) >= 3) & move60 & shares60
    # 4. The fast rule without one-print bursts.
    top = trailing_max(V, 6)
    out["4 no block"] = out["F60x4"] & (ratio(top, v60) <= 0.7)
    # 5. Breakouts with volume: today's high/low, or the last 30 minutes'.
    day_hi = fv.shifted(np.fmax.accumulate(H, axis=1), 6)
    day_lo = fv.shifted(np.fmin.accumulate(L, axis=1), 6)
    after15 = np.arange(S) >= 90
    out["5 day break"] = ((C > day_hi) | (C < day_lo)) & (r60 >= 3) & after15 & shares60
    hi30 = fv.shifted(trailing_max(H, 180), 6)
    lo30 = fv.shifted(trailing_min(L, 180), 6)
    out["5b 30m break"] = ((C > hi30) | (C < lo30)) & (r60 >= 3) & (np.arange(S) >= 186) & shares60
    # 6. Range expansion: 60-s high-low range.
    rng = (trailing_max(H, 6) - trailing_min(L, 6)) / C
    out["6 range"] = (ratio(rng, pm(rng)) >= 4) & (r60 >= 2) & shares60
    # 7. Quiet 30 minutes, then the fast rule at 3x.
    quiet_rng = fv.shifted((trailing_max(H, 180) - trailing_min(L, 180)) / C, 6)
    quiet = (ratio(quiet_rng, pm(quiet_rng)) <= 0.5) & (np.arange(S) >= 186)
    out["7 quiet+burst"] = out["F60x3"] & quiet
    # 8. Move beyond SPY x beta.
    spy60 = (spy / fv.shifted(spy, 6) - 1) * 100
    res = np.abs(mv60 - beta[:, None] * spy60)
    out["8 vs SPY"] = (res >= 3 * pm(res)) & (res >= 0.29) & (r60 >= 3) & shares60
    # 11. The fast rule only on busy days: day volume >= 2x, or a 3% gap.
    cum = np.cumsum(V, axis=1)
    busy = ratio(cum, pm(cum)) >= 2
    first = np.array([row[~np.isnan(row)][0] if (~np.isnan(row)).any() else np.nan for row in O])
    prev_close = np.concatenate([[np.nan], C[:-1, -1]])
    gap = np.abs(first / prev_close - 1) >= 0.03
    out["11 busy day"] = out["F60x4"] & (busy | gap[:, None])
    return out


def moves(C, unit, exc, ok):
    """Biggest moves of each day: (day, start, peak, dir, units)."""
    q = ok & (exc >= BIG * unit)
    out = []
    for d in range(C.shape[0]):
        idx = np.flatnonzero(q[d])
        if not len(idx):
            continue
        runs, cur = [], [idx[0]]
        for t in idx[1:]:
            if t - cur[-1] <= MERGE:
                cur.append(t)
            else:
                runs.append(cur)
                cur = [t]
        runs.append(cur)
        last_peak = -1
        for run in runs:
            t0 = run[0]
            if t0 <= last_peak:
                continue
            p0 = C[d, t0]
            seg = C[d, t0 + 1 : min(t0 + H60, S - 1) + 1]
            k = int(np.argmax(np.abs(seg / p0 - 1)))
            peak = t0 + 1 + k
            sgn = 1 if seg[k] > p0 else -1
            # The move starts at the swing low (high) before the peak, not
            # at the first slot the 60-minute look-ahead qualifies.
            base = C[d, t0:peak]
            start = int(t0) + int(np.argmin(base) if sgn > 0 else np.argmax(base))
            out.append((d, start, int(peak), sgn, float(exc[d, t0] / unit[d, t0])))
            last_peak = peak
    return out


def work(job):
    symbol, opens, full, dates, split, spy_rows = job
    db = sqlite3.connect(f"file:{fv.DB}?mode=ro", uri=True)
    m = load(db, symbol, opens)
    keep = full & (m["V"].sum(axis=1) > 0)
    m = {k: v[keep] for k, v in m.items()}
    ds = [dates[i] for i in np.flatnonzero(keep)]
    if len(ds) <= DAYS:
        return symbol, None
    m["Craw"] = m["C"]
    C = fv.ffill(m["C"])
    m["C"] = C
    for k in ("H", "L", "O"):
        m[k] = np.where(np.isnan(m[k]), C, m[k]) if k != "O" else m[k]
    spy = spy_rows[np.flatnonzero(keep)]
    # Beta from daily closes, previous 60 sessions (at least 20).
    r = C[1:, -1] / C[:-1, -1] - 1
    rs = spy[1:, -1] / spy[:-1, -1] - 1
    beta = np.ones(len(ds))
    for d in range(21, len(ds)):
        a, b = r[max(0, d - 61) : d - 1], rs[max(0, d - 61) : d - 1]
        if np.var(b) > 0:
            beta[d] = np.cov(a, b)[0, 1] / np.var(b, ddof=1)
    lo, hi = split
    in_split = np.array([lo <= d <= hi for d in ds])
    in_split[:DAYS] = False
    exc = forward_travel(C, H60)
    unit = fv.past_median(exc)
    ok = in_split[:, None] & ~np.isnan(exc) & ~np.isnan(unit) & (unit > 0)
    mv = moves(C, unit, exc, ok)
    # Share of slots that a useful alert window covers (the chance level).
    cover = np.zeros(C.shape, bool)
    for d, t0, peak, _, _ in mv:
        cover[d, max(0, t0 - USEFUL) : peak] = True
    st = rules(m, spy, beta)
    alerts = {}
    for name, s in st.items():
        if name == "A":
            sig, ev, br = s
            sig = sig & in_split[:, None]
            al = []
            for d in range(sig.shape[0]):
                above, lastt = False, -(10**9)
                for t in np.flatnonzero(ev[d]):
                    if br[d, t]:
                        above = False
                    x = sig[d, t]
                    if x and not above and t - lastt >= fv.COOLDOWN:
                        al.append((d, int(t)))
                        lastt = t
                    above = x
        else:
            al = fire(s & in_split[:, None], COOLDOWN)
        alerts[name] = al
    res = dict(
        days=int(in_split.sum()),
        slots=int(ok.sum()),
        covered=int((cover & ok).sum()),
        moves=[],
        alerts={},
    )
    for d, t0, peak, sgn, units in mv:
        row = dict(date=ds[d], start=t0, peak=peak, dir=sgn, units=units,
                   size=float(abs(C[d, peak] / C[d, t0] - 1)), caught={})
        for name, al in alerts.items():
            hits = [t for dd, t in al if dd == d and t0 - BEFORE <= t < peak]
            if hits:
                t = min(hits)
                left = sgn * (C[d, peak] - C[d, t]) / (sgn * (C[d, peak] - C[d, t0]))
                row["caught"][name] = [t, float(min(left, 1.0))]
        res["moves"].append(row)
    for name, al in alerts.items():
        res["alerts"][name] = [[ds[d], t, bool(cover[d, t])] for d, t in al]
    return symbol, res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=["tune", "check"], default="tune")
    ap.add_argument("--tickers", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=10)
    a = ap.parse_args()
    db = sqlite3.connect(f"file:{fv.DB}?mode=ro", uri=True)
    dates, opens, full = fv.sessions(db)
    spy = fv.ffill(load(db, "SPY", opens)["C"])
    symbols = open(a.tickers).read().split()
    split = fv.TUNE if a.split == "tune" else fv.CHECK
    jobs = [(s, opens, full, dates, split, spy) for s in symbols]
    out = {}
    with ProcessPoolExecutor(a.workers) as ex:
        for i, (sym, res) in enumerate(ex.map(work, jobs)):
            if res:
                out[sym] = res
            print(f"{i + 1}/{len(jobs)} {sym}", file=sys.stderr)
    json.dump(dict(split=a.split, symbols=out), open(a.out, "w"))


if __name__ == "__main__":
    main()
