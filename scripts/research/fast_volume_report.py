"""Summarizes fast_volume.py output: quality, noise and speed per rule.

  python3 -I scripts/research/fast_volume_report.py <run.json> [--json out.json]
"""

import json
import sys
from collections import defaultdict

import numpy as np

MATCH = 90  # 15 minutes of 10-s slots, either side of rule A's alert


def boot(rows, dates, reps=1000, seed=7):
    """95% CI of hits / expected, resampling whole dates."""
    by = defaultdict(lambda: [0.0, 0.0])
    for r in rows:
        by[r["date"]][0] += r["hit"]
        by[r["date"]][1] += r["tod"]
    h = np.array([by[d][0] for d in dates])
    e = np.array([by[d][1] for d in dates])
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(dates), (reps, len(dates)))
    lifts = h[idx].sum(1) / np.maximum(e[idx].sum(1), 1e-9)
    return float(np.percentile(lifts, 2.5)), float(np.percentile(lifts, 97.5))


def summarize(run):
    alerts = run["alerts"]
    days = max(b["days"] for b in run["bases"].values() if b)
    base = sum(b["hits"] for b in run["bases"].values() if b) / sum(
        b["slots"] for b in run["bases"].values() if b
    )
    groups = defaultdict(list)
    for a in alerts:
        groups[(a["rule"], a["K"])].append(a)
    dates = sorted({a["date"] for a in alerts})
    # Rule A's alerts by symbol-date, for matching.
    a_by = defaultdict(list)
    for a in groups[("A", 4)]:
        a_by[(a["sym"], a["date"])].append(a)
    out = []
    for (rule, K), rows in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        sc = [r for r in rows if r["scored"]]
        hits = sum(r["hit"] for r in sc)
        exp_tod = sum(r["tod"] for r in sc)
        exp_day = sum(r["day"] for r in sc)
        lo, hi = boot(sc, dates)
        miss = [r for r in sc if not r["hit"]]
        faded = [r for r in miss if r["goOn"] is not None and r["goOn"] < 1.5]
        row = dict(
            rule=rule,
            K=K,
            perDay=len(rows) / days,
            scored=len(sc),
            hitRate=hits / len(sc) if sc else None,
            liftTod=hits / exp_tod if exp_tod else None,
            liftCI=[lo, hi],
            liftDay=hits / exp_day if exp_day else None,
            medianUnits=float(np.median([r["units"] for r in sc])) if sc else None,
            noise=1 - hits / len(sc) if sc else None,
            noiseFaded=len(faded) / len(sc) if sc else None,
            noiseNoMove=(len(miss) - len(faded)) / len(sc) if sc else None,
        )
        if rule != "A":
            r_by = defaultdict(list)
            for r in rows:
                r_by[(r["sym"], r["date"])].append(r)
            leads, moved, caught, n_a = [], [], 0, 0
            for key, alist in a_by.items():
                for a in alist:
                    n_a += 1
                    near = [r for r in r_by.get(key, []) if abs(r["slot"] - a["slot"]) <= MATCH]
                    if not near:
                        continue
                    caught += 1
                    first = min(near, key=lambda r: r["slot"])
                    leads.append((a["slot"] - first["slot"]) * 10)
                    if first["unit"]:
                        moved.append(abs(a["price"] / first["price"] - 1) / first["unit"])
            matched = set()
            new = []
            for key, rl in r_by.items():
                al = a_by.get(key, [])
                for r in rl:
                    if not any(abs(r["slot"] - a["slot"]) <= MATCH for a in al):
                        new.append(r)
            new_sc = [r for r in new if r["scored"]]
            leads = np.array(leads)
            row.update(
                caughtOfA=caught / n_a if n_a else None,
                medianLeadSec=float(np.median(leads)) if len(leads) else None,
                earlierShare=float((leads > 0).mean()) if len(leads) else None,
                movedBeforeAUnits=float(np.median(moved)) if moved else None,
                newShare=len(new) / len(rows) if rows else None,
                newHitRate=sum(r["hit"] for r in new_sc) / len(new_sc) if new_sc else None,
            )
        out.append(row)
    return dict(split=run["split"], days=days, baseRate=base, rows=out)


def main():
    run = json.load(open(sys.argv[1]))
    s = summarize(run)
    print(f"split {s['split']}  days {s['days']}  base hit rate {s['baseRate']:.3f}")
    hdr = "rule  K    /day   hit   lift [CI]          day   units noise(fade/nomove) caughtA lead_s earlier movedA new  newHit"
    print(hdr)
    for r in s["rows"]:
        f = lambda v, p=2: "-" if v is None else f"{v:.{p}f}"
        print(
            f"{r['rule']:5}{r['K']:<4}{r['perDay']:6.1f} {f(r['hitRate'])} {f(r['liftTod'])} "
            f"[{r['liftCI'][0]:.2f}-{r['liftCI'][1]:.2f}] {f(r['liftDay'])} {f(r['medianUnits'])} "
            f"{f(r['noise'])}({f(r['noiseFaded'])}/{f(r['noiseNoMove'])}) "
            f"{f(r.get('caughtOfA'))} {f(r.get('medianLeadSec'), 0)} {f(r.get('earlierShare'))} "
            f"{f(r.get('movedBeforeAUnits'))} {f(r.get('newShare'))} {f(r.get('newHitRate'))}"
        )
    if len(sys.argv) > 3 and sys.argv[2] == "--json":
        json.dump(s, open(sys.argv[3], "w"), indent=1)


if __name__ == "__main__":
    main()
