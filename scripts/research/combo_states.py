"""Two-rule combinations on the rules' conditions (not their alerts): the
combined condition holds at slot t when both rules' conditions held at some
slot in the last `--within` slots (t included). Fresh crossing, 30-minute
cooldown. Same moves and output shape as early_rules.py, so
early_rules_report.py summarizes it.

  python3 -I scripts/research/combo_states.py --split tune --tickers <file> --out run.json
"""

import argparse
import itertools
import json
import sqlite3
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

sys.path.insert(0, "scripts/research")
import early_rules as er  # noqa: E402
import fast_volume as fv  # noqa: E402

POOL = ["F60x2", "F60x4", "3 steady", "8 vs SPY", "6 range", "2 trades", "4 no block"]


def work(job):
    symbol, opens, full, dates, split, spy_rows, within, pairs = job
    db = sqlite3.connect(f"file:{fv.DB}?mode=ro", uri=True)
    m = er.load(db, symbol, opens)
    keep = full & (m["V"].sum(axis=1) > 0)
    m = {k: v[keep] for k, v in m.items()}
    ds = [dates[i] for i in np.flatnonzero(keep)]
    if len(ds) <= fv.DAYS:
        return symbol, None
    m["Craw"] = m["C"]
    C = fv.ffill(m["C"])
    m["C"] = C
    for k in ("H", "L"):
        m[k] = np.where(np.isnan(m[k]), C, m[k])
    spy = spy_rows[np.flatnonzero(keep)]
    r = C[1:, -1] / C[:-1, -1] - 1
    rs = spy[1:, -1] / spy[:-1, -1] - 1
    beta = np.ones(len(ds))
    for d in range(21, len(ds)):
        a, b = r[max(0, d - 61) : d - 1], rs[max(0, d - 61) : d - 1]
        if np.var(b) > 0:
            beta[d] = np.cov(a, b)[0, 1] / np.var(b, ddof=1)
    lo, hi = split
    in_split = np.array([lo <= d <= hi for d in ds])
    in_split[: fv.DAYS] = False
    exc = er.forward_travel(C, er.H60)
    unit = fv.past_median(exc)
    ok = in_split[:, None] & ~np.isnan(exc) & ~np.isnan(unit) & (unit > 0)
    mv = er.moves(C, unit, exc, ok)
    cover = np.zeros(C.shape, bool)
    for d, t0, peak, _, _ in mv:
        cover[d, max(0, t0 - er.USEFUL) : peak] = True
    st = er.rules(m, spy, beta)
    recent = {n: er.trailing_max(st[n].astype(np.uint8), within).astype(bool) for n in POOL}
    alerts = {}
    for x, y in pairs:
        both = recent[x] & recent[y] & (st[x] | st[y])
        alerts[f"{x} + {y}"] = er.fire(both & in_split[:, None], er.COOLDOWN)
    res = dict(days=int(in_split.sum()), slots=int(ok.sum()), covered=int((cover & ok).sum()), moves=[], alerts={})
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=["tune", "check"], default="tune")
    ap.add_argument("--tickers", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--within", type=int, default=12)
    ap.add_argument("--pairs", help='"a|b,c|d"; default every pair of the pool')
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    pairs = (
        [tuple(p.split("|")) for p in a.pairs.split(",")]
        if a.pairs
        else list(itertools.combinations(POOL, 2))
    )
    db = sqlite3.connect(f"file:{fv.DB}?mode=ro", uri=True)
    dates, opens, full = fv.sessions(db)
    spy = fv.ffill(er.load(db, "SPY", opens)["C"])
    split = fv.TUNE if a.split == "tune" else fv.CHECK
    jobs = [(s, opens, full, dates, split, spy, a.within, pairs) for s in open(a.tickers).read().split()]
    out = {}
    with ProcessPoolExecutor(a.workers) as ex:
        for i, (sym, res) in enumerate(ex.map(work, jobs)):
            if res:
                out[sym] = res
            print(f"{i + 1}/{len(jobs)} {sym}", file=sys.stderr)
    json.dump(dict(split=a.split, symbols=out), open(a.out, "w"))


if __name__ == "__main__":
    main()
