"""Price-led early signs of the biggest moves: signs in the price that may come
before the volume burst (user, 2026-10-27). Same biggest moves, scoring and
output shape as early_rules.py, so early_rules_report.py summarizes a run.

Rules (fresh crossing, 30-minute cooldown, only slots <= t):
  P1 squeeze then expansion: the 30 minutes before the last 2 have a high-low
     range <= 0.6x its 20-session median; the last 2 minutes' range >= 2x its
     median.
  P2 staircase: the last 4 rolling one-minute lows each higher than the one
     before (highs lower, for a drop) and the 3-minute move >= 1.5x normal in
     that direction. No volume condition.
  P3 price-only fast: 60-s |move| >= 4x normal and >= 0.29%. No volume.
  P4 VWAP cross: the price has been on one side of today's VWAP for the last
     60 s after being on the other side just before, and the 3-minute move >=
     1.5x normal toward that side. From 9:35.
  P5 strength vs SPY: 5-minute residual (stock - beta x SPY) >= 3x normal and
     5-minute volume >= 1.5x normal.
  P6 mild tilt: 2-minute volume >= 2x normal and 2-minute move >= 2x normal,
     the last 10 s not against it.
  P7 clean drift (own idea): 5-minute move >= 1.5x normal with an efficiency
     ratio |C[t] - C[t-30]| / sum|dC| over those 30 slots >= 0.6.
  P8 quiet then P3 (own idea): P3 at 3x when the 30 minutes before were quiet
     (range <= 0.6x normal).

  python3 -I scripts/research/price_signs.py --split tune --tickers <file> --out run.json
  python3 -I scripts/research/price_signs.py --summary run.json --base er.json --save out.json
"""

import argparse
import json
import sqlite3
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

sys.path.insert(0, "scripts/research")
import early_rules as er  # noqa: E402
import early_rules_report as rep  # noqa: E402
import fast_volume as fv  # noqa: E402

S, DAYS = fv.S, fv.DAYS
BASELINE = ["A", "F60x2", "3 steady", "6 range"]


def load_vwap(db, symbol, opens):
    rows = np.array(
        db.execute(
            "select start, vwap from bars where symbol = ? order by start",
            (symbol,),
        ).fetchall(),
        dtype=np.float64,
    )
    W = np.full((len(opens), S), np.nan)
    if len(rows):
        start = rows[:, 0].astype(np.int64)
        di = np.searchsorted(opens, start, side="right") - 1
        slot = (start - opens[np.clip(di, 0, None)]) // 10
        ok = (di >= 0) & (slot >= 0) & (slot < S)
        W[di[ok], slot[ok]] = rows[ok, 1]
    return W


def rules(m, spy, beta):
    V, C, H, L, W = m["V"], m["C"], m["H"], m["L"], m["W"]
    pm, ratio, sh = fv.past_median, er.ratio, fv.shifted
    tmax, tmin = er.trailing_max, er.trailing_min
    t = np.arange(S)
    out = {}

    def move(k):
        return (C / sh(C, k) - 1) * 100

    last = C - sh(C, 1)
    # P1: quiet 30 minutes (ending 2 minutes ago), then a wide 2 minutes.
    rng30 = sh((tmax(H, 180) - tmin(L, 180)) / C, 12)
    rng2 = (tmax(H, 12) - tmin(L, 12)) / C
    quiet = (ratio(rng30, pm(rng30)) <= 0.6) & (t >= 192)
    out["P1 squeeze+expand"] = quiet & (ratio(rng2, pm(rng2)) >= 2)
    # P2: rolling one-minute lows (highs) stepping up (down).
    lows = [sh(tmin(L, 6), 6 * k) if k else tmin(L, 6) for k in range(4)]
    highs = [sh(tmax(H, 6), 6 * k) if k else tmax(H, 6) for k in range(4)]
    up = (lows[0] > lows[1]) & (lows[1] > lows[2]) & (lows[2] > lows[3])
    down = (highs[0] < highs[1]) & (highs[1] < highs[2]) & (highs[2] < highs[3])
    m3 = move(18)
    big3 = np.abs(m3) >= 1.5 * pm(np.abs(m3))
    out["P2 staircase"] = big3 & ((up & (m3 > 0)) | (down & (m3 < 0)))
    # P3: price-only fast.
    a60 = np.abs(move(6))
    out["P3 price only"] = (a60 >= 4 * pm(a60)) & (a60 >= 0.29)
    # P4: VWAP cross held 60 s.
    vw = np.cumsum(np.nan_to_num(W) * V, axis=1) / np.maximum(np.cumsum(V, axis=1), 1)
    vw = np.where(np.cumsum(V, axis=1) > 0, vw, np.nan)
    above = (C > vw).astype(float)
    below = (C < vw).astype(float)
    held_up = (fv.window_sum(above, 6) == 6) & (sh(above, 6) == 0)
    held_dn = (fv.window_sum(below, 6) == 6) & (sh(below, 6) == 0)
    out["P4 vwap cross"] = big3 & ((held_up & (m3 > 0)) | (held_dn & (m3 < 0))) & (t >= 30)
    # P5: 5-minute strength vs SPY with mild volume.
    spy5 = (spy / sh(spy, 30) - 1) * 100
    res = np.abs(move(30) - beta[:, None] * spy5)
    v5 = fv.window_sum(V, 30)
    out["P5 vs SPY 5m"] = (res >= 3 * pm(res)) & (ratio(v5, pm(v5)) >= 1.5)
    # P6: a mild tilt in volume and price over 2 minutes.
    v2 = fv.window_sum(V, 12)
    m2 = move(12)
    a2 = np.abs(m2)
    agree = ((m2 > 0) & (last >= 0)) | ((m2 < 0) & (last <= 0))
    out["P6 mild tilt"] = (ratio(v2, pm(v2)) >= 2) & (a2 >= 2 * pm(a2)) & agree
    # P7: clean 5-minute drift.
    m5 = move(30)
    a5 = np.abs(m5)
    path = fv.window_sum(np.abs(np.nan_to_num(last)), 30)
    eff = ratio(np.abs(C - sh(C, 30)), path)
    out["P7 clean drift"] = (a5 >= 1.5 * pm(a5)) & (eff >= 0.6)
    # P8: quiet 30 minutes (ending 60 s ago), then price-only at 3x.
    rng30b = sh((tmax(H, 180) - tmin(L, 180)) / C, 6)
    quiet_b = (ratio(rng30b, pm(rng30b)) <= 0.6) & (t >= 186)
    out["P8 quiet+price"] = quiet_b & (a60 >= 3 * pm(a60)) & (a60 >= 0.29)
    return out


def work(job):
    symbol, opens, full, dates, split, spy_rows = job
    db = sqlite3.connect(f"file:{fv.DB}?mode=ro", uri=True)
    m = er.load(db, symbol, opens)
    m["W"] = load_vwap(db, symbol, opens)
    keep = full & (m["V"].sum(axis=1) > 0)
    m = {k: v[keep] for k, v in m.items()}
    ds = [dates[i] for i in np.flatnonzero(keep)]
    if len(ds) <= DAYS:
        return symbol, None
    C = fv.ffill(m["C"])
    m["C"] = C
    m["H"] = np.where(np.isnan(m["H"]), C, m["H"])
    m["L"] = np.where(np.isnan(m["L"]), C, m["L"])
    spy = spy_rows[np.flatnonzero(keep)]
    # Beta as in early_rules.py: daily closes, previous 60 sessions (>= 20).
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
    exc = er.forward_travel(C, er.H60)
    unit = fv.past_median(exc)
    ok = in_split[:, None] & ~np.isnan(exc) & ~np.isnan(unit) & (unit > 0)
    mv = er.moves(C, unit, exc, ok)
    cover = np.zeros(C.shape, bool)
    for d, t0, peak, _, _ in mv:
        cover[d, max(0, t0 - er.USEFUL) : peak] = True
    alerts = {
        name: er.fire(s & in_split[:, None], er.COOLDOWN)
        for name, s in rules(m, spy, beta).items()
    }
    res = dict(days=int(in_split.sum()), slots=int(ok.sum()), covered=int((cover & ok).sum()),
               moves=[], alerts={})
    for d, t0, peak, sgn, units in mv:
        row = dict(date=ds[d], start=t0, peak=peak, dir=sgn, units=units,
                   size=float(abs(C[d, peak] / C[d, t0] - 1)), caught={})
        for name, al in alerts.items():
            hits = [t for dd, t in al if dd == d and t0 - er.BEFORE <= t < peak]
            if hits:
                t = min(hits)
                left = sgn * (C[d, peak] - C[d, t]) / (sgn * (C[d, peak] - C[d, t0]))
                row["caught"][name] = [t, float(min(left, 1.0))]
        res["moves"].append(row)
    for name, al in alerts.items():
        res["alerts"][name] = [[ds[d], t, bool(cover[d, t])] for d, t in al]
    return symbol, res


def top20(run, names):
    mv = [m for r in run["symbols"].values() for m in r["moves"]]
    cut = np.percentile([m["size"] for m in mv], 80)
    top = [m for m in mv if m["size"] >= cut]
    out = {}
    for name in names:
        c = [m for m in top if name in m["caught"]]
        e = [m for m in c if m["caught"][name][1] >= 0.75]
        after = [(m["caught"][name][0] - m["start"]) * 10 / 60 for m in c]
        out[name] = dict(caught=len(c) / len(top), early=len(e) / len(top),
                         minAfterStart=float(np.median(after)) if after else None)
    return dict(n=len(top), cut=float(cut), rules=out)


def summary(path, base_path, save):
    run = json.load(open(path))
    base = json.load(open(base_path))
    # Keep only the baseline rules from the early_rules run, same stocks.
    for sym, r in base["symbols"].items():
        r["alerts"] = {k: v for k, v in r["alerts"].items() if k in BASELINE}
        for m in r["moves"]:
            m["caught"] = {k: v for k, v in m["caught"].items() if k in BASELINE}
    s_new, s_base = rep.summarize(run), rep.summarize(base)
    names_new = [r["rule"] for r in s_new["rows"]]
    t_new, t_base = top20(run, names_new), top20(base, BASELINE)
    rows = []
    for s, t in ((s_base, t_base), (s_new, t_new)):
        for r in s["rows"]:
            r["top20"] = t["rules"][r["rule"]]
            rows.append(r)
    out = dict(split=run["split"], days=s_new["days"], symbols=s_new["symbols"],
               moves=s_new["moves"], movesBase=s_base["moves"], cover=s_new["cover"],
               top20=dict(n=t_new["n"], cut=t_new["cut"], nBase=t_base["n"]), rows=rows)
    json.dump(out, open(save, "w"), indent=1)
    f = lambda v, p=2: "   -" if v is None else f"{v:.{p}f}"
    print(f"split {out['split']}  {out['symbols']} stocks  {out['days']} days  moves {out['moves']} "
          f"(base run {out['movesBase']})  top20 n {t_new['n']} (>= {t_new['cut']*100:.1f}%)  chance {out['cover']:.3f}")
    print("rule              /day  caught early afterStart_m  useful lift | top20 caught early afterStart_m")
    for r in rows:
        t = r["top20"]
        after = None if r["medianAfterStartSec"] is None else r["medianAfterStartSec"] / 60
        print(f"{r['rule']:17}{r['perDay']:6.1f}  {f(r['caught'])}  {f(r['early'])}  {f(after, 1):>8}     "
              f"{f(r['useful'])}  {f(r['usefulLift'], 1):>4} |  {f(t['caught'])}  {f(t['early'])}  "
              f"{f(t['minAfterStart'], 1):>8}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=["tune", "check"], default="tune")
    ap.add_argument("--tickers")
    ap.add_argument("--out")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--summary")
    ap.add_argument("--base")
    ap.add_argument("--save")
    a = ap.parse_args()
    if a.summary:
        summary(a.summary, a.base, a.save)
        return
    db = sqlite3.connect(f"file:{fv.DB}?mode=ro", uri=True)
    dates, opens, full = fv.sessions(db)
    spy = fv.ffill(er.load(db, "SPY", opens)["C"])
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
