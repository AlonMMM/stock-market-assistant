"""Summarizes early_rules.py output, one row per rule.

  python3 -I scripts/research/early_rules_report.py run.json [--json out.json]
"""

import json
import sys

import numpy as np

ORDER = ["A", "F60x4", "F60x3", "F60x2", "1 jump", "2 trades", "3 steady", "4 no block",
         "5 day break", "5b 30m break", "6 range", "7 quiet+burst", "8 vs SPY", "11 busy day"]


def summarize(run):
    syms = run["symbols"]
    days = max(r["days"] for r in syms.values())
    n_sym = len(syms)
    moves = [m for r in syms.values() for m in r["moves"]]
    biggest = [m for m in moves if m["units"] >= 6]
    cover = sum(r["covered"] for r in syms.values()) / sum(r["slots"] for r in syms.values())
    rows = []
    # Known rules in their usual order, then any other rule found in the run.
    found = {k for r in syms.values() for k in r["alerts"]}
    names = [n for n in ORDER if n in found] + sorted(found - set(ORDER))
    for name in names:
        alerts = [a for r in syms.values() for a in r["alerts"].get(name, [])]
        caught = [m["caught"][name] for m in moves if name in m["caught"]]
        caught_m = [m for m in moves if name in m["caught"]]
        left = np.array([c[1] for c in caught]) if caught else np.array([])
        lead = [(m["peak"] - m["caught"][name][0]) * 10 / 60 for m in caught_m]
        after = [(m["caught"][name][0] - m["start"]) * 10 for m in caught_m]
        big_early = [m for m in biggest if name in m["caught"] and m["caught"][name][1] >= 0.75]
        useful = sum(a[2] for a in alerts)
        rows.append(dict(
            rule=name,
            perDay=len(alerts) / days,
            perStockDay=len(alerts) / days / n_sym,
            caught=len(caught) / len(moves),
            early=float((left >= 0.75).sum()) / len(moves),
            biggestEarly=len(big_early) / len(biggest) if biggest else None,
            medianLeft=float(np.median(left)) if len(left) else None,
            medianAfterStartSec=float(np.median(after)) if after else None,
            medianBeforePeakMin=float(np.median(lead)) if lead else None,
            useful=useful / len(alerts) if alerts else None,
            usefulLift=useful / len(alerts) / cover if alerts else None,
        ))
    return dict(split=run["split"], days=days, symbols=n_sym, moves=len(moves),
                movesPerDay=len(moves) / days, biggest=len(biggest), cover=cover,
                medianMoveSize=float(np.median([m["size"] for m in moves])),
                medianMoveMinutes=float(np.median([(m["peak"] - m["start"]) / 6 for m in moves])),
                rows=rows)


def main():
    s = summarize(json.load(open(sys.argv[1])))
    print(f"split {s['split']}  {s['symbols']} stocks  {s['days']} days  moves {s['moves']} "
          f"({s['movesPerDay']:.1f}/day; median {s['medianMoveSize']*100:.1f}% over "
          f"{s['medianMoveMinutes']:.0f} min)  biggest (>=6 units) {s['biggest']}  chance {s['cover']:.3f}")
    print("rule            /day  /stk  caught early big6early left  afterStart_s beforePeak_m useful lift")
    f = lambda v, p=2: "   -" if v is None else f"{v:.{p}f}"
    for r in s["rows"]:
        print(f"{r['rule']:14}{r['perDay']:6.1f} {r['perStockDay']:.2f}  {f(r['caught'])}  {f(r['early'])}  "
              f"{f(r['biggestEarly'])}     {f(r['medianLeft'])}  {f(r['medianAfterStartSec'], 0):>8}  "
              f"{f(r['medianBeforePeakMin'], 1):>8}    {f(r['useful'])}  {f(r['usefulLift'], 1)}")
    if len(sys.argv) > 3:
        json.dump(s, open(sys.argv[3], "w"), indent=1)


if __name__ == "__main__":
    main()
