"""Direction a few seconds to minutes after an alert (user, 2026-10-27: "find
a clear direction for these rules couple of seconds/minutes after they occur -
it will also filter a lot ... much less trades per day and maximize the
winners"). Stock price only; no options, no bot.

Alerts come from early_rules.py runs (/tmp/claude-501/fv/er_<split>.json, the
66 Favorites). For each alert at slot t and wait w, the decision is at
T = t + w; a method returns up, down or skip (the filter). The trade enters at
the 10-s close at T and is judged in the stock's own units: unit = the median
60-minute travel at that slot over the previous 20 sessions (as in
early_rules). WIN = +2 units in the side's direction before -1 unit against,
within 60 minutes (or to the close); the result in units is +2, -1, or the
move at 60 minutes / the close. A random direction's result is the average of
both sides (its expected value), on the same trades.

Methods (side at T, else skip):
  naive  sign of the alert's 60-s move (no filter)
  D1k    |C[T] / C[t] - 1| >= k x the 60-s normal move (k = 1, 2); side = sign
  D2     C[T] above the high (below the low) of the 60 s up to the alert
  D3     side of today's VWAP, only when it agrees with the move since t
  D4     volume x sign(close change) over the slots since t: |net| >= 60% of volume
  D5     move since t beyond beta x SPY: |residual| >= 1 x the 60-s normal move

  python3 -I scripts/research/direction_confirm.py --split tune --out runs.npz
"""

import argparse
import json
import sqlite3
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

sys.path.insert(0, "scripts/research")
import early_rules as er  # noqa: E402
import fast_volume as fv  # noqa: E402

S, DAYS = fv.S, fv.DAYS
WAITS = [0, 1, 3, 6, 12, 30]  # slots: 0, 10 s, 30 s, 60 s, 2 min, 5 min
SOURCES = ["F60x2", "3 steady", "8 vs SPY", "6 range", "2 trades", "A"]
METHODS = ["naive", "D1k1", "D1k2", "D2", "D3", "D4", "D5"]
H60, H30 = 360, 180


def trade(path, entry, u, side, up=2.0, down=1.0):
    """(result in units, won) for a +up / -down bracket over the path."""
    if not len(path) or not (u > 0):
        return np.nan, np.nan
    r = side * (path / entry - 1) / u
    hit_up = np.flatnonzero(r >= up)
    hit_dn = np.flatnonzero(r <= -down)
    a = hit_up[0] if len(hit_up) else 10**9
    b = hit_dn[0] if len(hit_dn) else 10**9
    if a < b:
        return up, 1.0
    if b < a:
        return -down, 0.0
    return float(r[-1]), 0.0


def work(job):
    symbol, opens, full, dates, spy_rows, alerts = job
    db = sqlite3.connect(f"file:{fv.DB}?mode=ro", uri=True)
    m = er.load(db, symbol, opens)
    keep = full & (m["V"].sum(axis=1) > 0)
    m = {k: v[keep] for k, v in m.items()}
    ds = [dates[i] for i in np.flatnonzero(keep)]
    if len(ds) <= DAYS:
        return None
    C = fv.ffill(m["C"])
    V = m["V"]
    H = np.where(np.isnan(m["H"]), C, m["H"])
    L = np.where(np.isnan(m["L"]), C, m["L"])
    spy = spy_rows[np.flatnonzero(keep)]
    r = C[1:, -1] / C[:-1, -1] - 1
    rs = spy[1:, -1] / spy[:-1, -1] - 1
    beta = np.ones(len(ds))
    for d in range(21, len(ds)):
        a, b = r[max(0, d - 61) : d - 1], rs[max(0, d - 61) : d - 1]
        if np.var(b) > 0:
            beta[d] = np.cov(a, b)[0, 1] / np.var(b, ddof=1)
    unit = fv.past_median(er.forward_travel(C, H60))
    m60 = fv.past_median(np.abs(C / fv.shifted(C, 6) - 1))
    vwap = np.cumsum(C * V, axis=1) / np.maximum(np.cumsum(V, axis=1), 1)
    hi60 = er.trailing_max(H, 6)
    lo60 = er.trailing_min(L, 6)
    day = {d: i for i, d in enumerate(ds)}
    rows = []
    for si, src in enumerate(SOURCES):
        for date, t, _ in alerts.get(src, []):
            d = day.get(date)
            if d is None or t < 6:
                continue
            naive = np.sign(C[d, t] - C[d, t - 6])
            for wi, w in enumerate(WAITS):
                T = t + w
                if T >= S - 1:
                    continue
                u = unit[d, T]
                if not (u > 0):
                    continue
                entry = C[d, T]
                p60 = C[d, T + 1 : min(T + H60, S - 1) + 1]
                p30 = C[d, T + 1 : min(T + H30, S - 1) + 1]
                ru, wu = trade(p60, entry, u, 1)
                rd, wd = trade(p60, entry, u, -1)
                ru30, wu30 = trade(p30, entry, u, 1, 1.0, 1.0)
                rd30, wd30 = trade(p30, entry, u, -1, 1.0, 1.0)
                ch = C[d, T] / C[d, t] - 1
                norm = m60[d, t]
                sides = [naive]
                for k in (1, 2):
                    sides.append(np.sign(ch) if w > 0 and norm > 0 and abs(ch) >= k * norm else 0)
                if w > 0 and C[d, T] > hi60[d, t]:
                    sides.append(1)
                elif w > 0 and C[d, T] < lo60[d, t]:
                    sides.append(-1)
                else:
                    sides.append(0)
                vs = np.sign(C[d, T] - vwap[d, T])
                sides.append(vs if w > 0 and vs != 0 and vs == np.sign(ch) else 0)
                if w > 0:
                    seg = slice(t + 1, T + 1)
                    vol = V[d, seg]
                    net = (vol * np.sign(C[d, seg] - C[d, t:T])).sum()
                    tot = vol.sum()
                    sides.append(np.sign(net) if tot > 0 and abs(net) >= 0.6 * tot else 0)
                else:
                    sides.append(0)
                res = ch - beta[d] * (spy[d, T] / spy[d, t] - 1)
                sides.append(np.sign(res) if w > 0 and norm > 0 and abs(res) >= norm else 0)
                rows.append([si, wi, d, t, ru, wu, rd, wd, ru30, wu30, rd30, wd30, *sides])
    return dict(symbol=symbol, dates=ds, rows=np.array(rows, dtype=np.float64))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=["tune", "check"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--alerts", help="early_rules.py run (default /tmp/claude-501/fv/er_<split>.json)")
    a = ap.parse_args()
    run = json.load(open(a.alerts or f"/tmp/claude-501/fv/er_{a.split}.json"))
    db = sqlite3.connect(f"file:{fv.DB}?mode=ro", uri=True)
    dates, opens, full = fv.sessions(db)
    spy = fv.ffill(er.load(db, "SPY", opens)["C"])
    jobs = [(s, opens, full, dates, spy, r["alerts"]) for s, r in run["symbols"].items()]
    out, syms, sdates = [], [], {}
    with ProcessPoolExecutor(a.workers) as ex:
        for i, res in enumerate(ex.map(work, jobs)):
            if res is None or not len(res["rows"]):
                continue
            k = len(syms)
            syms.append(res["symbol"])
            sdates[res["symbol"]] = res["dates"]
            rows = res["rows"]
            # Date as a global string index, symbol as an index.
            date_str = np.array([res["dates"][int(d)] for d in rows[:, 2]])
            out.append((np.full(len(rows), k), date_str, rows))
            print(f"{i + 1}/{len(jobs)} {res['symbol']} {len(rows)}", file=sys.stderr)
    sym = np.concatenate([o[0] for o in out])
    date = np.concatenate([o[1] for o in out])
    rows = np.concatenate([o[2] for o in out])
    days = max(r["days"] for r in run["symbols"].values())
    np.savez_compressed(a.out, sym=sym, date=date, rows=rows, syms=np.array(syms), days=days)


if __name__ == "__main__":
    main()
