"""Summarizes direction_confirm.py runs: per alert source, wait and method.

  python3 -I scripts/research/direction_report.py runs.npz [--json out.json] [--only combos.json]

Edge = average units of the chosen side minus a random side's average on the
same trades; its 95% CI resamples whole dates.
"""

import argparse
import itertools
import json

import numpy as np

SOURCES = ["F60x2", "3 steady", "8 vs SPY", "6 range", "2 trades", "A"]
WAITS = ["0s", "10s", "30s", "60s", "2m", "5m"]
METHODS = ["naive", "D1k1", "D1k2", "D2", "D3", "D4", "D5"]
SIDE0 = 12


def stats(rows, side, date, days, reps=500, seed=3):
    up = side > 0
    res = np.where(up, rows[:, 4], rows[:, 6])
    win = np.where(up, rows[:, 5], rows[:, 7])
    win30 = np.where(up, rows[:, 9], rows[:, 11])
    rnd = (rows[:, 4] + rows[:, 6]) / 2
    rnd_win = (rows[:, 5] + rows[:, 7]) / 2
    n = len(rows)
    out = dict(
        trades=n,
        perDay=n / days,
        win=float(win.mean()) if n else None,
        win30=float(win30.mean()) if n else None,
        avg=float(res.mean()) if n else None,
        perDayUnits=float(res.sum() / days),
        randomWin=float(rnd_win.mean()) if n else None,
        randomAvg=float(rnd.mean()) if n else None,
    )
    if n:
        edge = res - rnd
        out["edge"] = float(edge.mean())
        u, inv = np.unique(date, return_inverse=True)
        es = np.bincount(inv, edge, len(u))
        ns = np.bincount(inv, None, len(u))
        rng = np.random.default_rng(seed)
        idx = rng.integers(0, len(u), (reps, len(u)))
        boot = es[idx].sum(1) / np.maximum(ns[idx].sum(1), 1)
        out["edgeCI"] = [float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))]
        avg_s = np.bincount(inv, res, len(u))
        boot_a = avg_s[idx].sum(1) / np.maximum(ns[idx].sum(1), 1)
        out["avgCI"] = [float(np.percentile(boot_a, 2.5)), float(np.percentile(boot_a, 97.5))]
    return out


def first_per_day(sym, date, t, mask):
    """Keep the first selected alert per symbol-date."""
    idx = np.flatnonzero(mask)
    order = idx[np.lexsort((t[idx], date[idx], sym[idx]))]
    seen, keep = set(), []
    for i in order:
        k = (sym[i], date[i])
        if k not in seen:
            seen.add(k)
            keep.append(i)
    m = np.zeros(len(mask), bool)
    m[keep] = True
    return m


def combos():
    for mi, m in enumerate(METHODS):
        yield m, [mi]
    for a, b in itertools.combinations(range(1, len(METHODS)), 2):
        yield f"{METHODS[a]}+{METHODS[b]}", [a, b]


def side_of(rows, mis):
    sides = rows[:, [SIDE0 + i for i in mis]]
    agree = np.all(sides == sides[:, :1], axis=1) & (sides[:, 0] != 0)
    return np.where(agree, sides[:, 0], 0)


def summarize(path, only=None):
    z = np.load(path, allow_pickle=False)
    rows, sym, date, days = z["rows"], z["sym"], z["date"], int(z["days"])
    out = []
    for si, src in enumerate(SOURCES):
        for wi, w in enumerate(WAITS):
            sub = (rows[:, 0] == si) & (rows[:, 1] == wi)
            if not sub.any():
                continue
            R, Sy, D = rows[sub], sym[sub], date[sub]
            for name, mis in combos():
                if wi == 0 and name != "naive":
                    continue
                for per in ("all", "1/day"):
                    key = dict(source=src, wait=w, method=name, per=per)
                    if only is not None and key not in only:
                        continue
                    side = side_of(R, mis)
                    mask = side != 0
                    if per == "1/day":
                        mask = first_per_day(Sy, D, R[:, 3], mask)
                    if mask.sum() < 30:
                        continue
                    st = stats(R[mask], side[mask], D[mask], days)
                    out.append({**key, **st})
    return dict(path=path, days=days, rows=out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--json")
    ap.add_argument("--only")
    ap.add_argument("--top", type=int, default=40)
    a = ap.parse_args()
    only = json.load(open(a.only)) if a.only else None
    s = summarize(a.run, only)
    if a.json:
        json.dump(s, open(a.json, "w"), indent=1)
    rows = s["rows"]
    fmt = lambda r: (
        f"{r['source']:9} {r['wait']:4} {r['method']:10} {r['per']:5} {r['perDay']:6.1f}/d "
        f"win {r['win']:.3f} (rnd {r['randomWin']:.3f}) avg {r['avg']:+.3f} [{r['avgCI'][0]:+.3f},{r['avgCI'][1]:+.3f}] "
        f"edge {r['edge']:+.3f} [{r['edgeCI'][0]:+.3f},{r['edgeCI'][1]:+.3f}] u/day {r['perDayUnits']:+.1f} win30 {r['win30']:.3f}"
    )
    print(f"days {s['days']}")
    if only is not None:
        for r in rows:
            print(fmt(r))
        return
    print("-- baselines: naive direction, no wait")
    for r in rows:
        if r["wait"] == "0s":
            print(fmt(r))
    print(f"-- top {a.top} by average units (<= 40 trades/day, lower CI of avg > 0 first)")
    cand = [r for r in rows if r["perDay"] <= 40 and r["wait"] != "0s"]
    cand.sort(key=lambda r: (r["avgCI"][0] > 0, r["avg"]), reverse=True)
    for r in cand[: a.top]:
        print(fmt(r))


if __name__ == "__main__":
    main()
