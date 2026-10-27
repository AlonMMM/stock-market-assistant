"""Exports the early-sign alerts as one CSV for other studies (the volume-bot
backtest runs in another session).

Reads the early_rules.py runs (single rules) and combo_states.py runs (two-rule
combinations) of both periods and writes one row per alert:

  rule, period, symbol, date, time_ny, slot

time_ny is the end of the 10-s slot (New York time) when the alert is known:
the first price a trader could act on comes after it. Today's rule (A) uses
its live 120-minute cooldown; every other rule fresh crossings and a
30-minute cooldown. No look-ahead fields are exported.

  python3 -I scripts/research/export_alerts.py --out data/local/early_alerts.csv \
      --runs /tmp/claude-501/fv/er_tune.json,/tmp/claude-501/fv/er_check.json,...
"""

import argparse
import csv
import json


def time_ny(slot):
    sec = 9 * 3600 + 30 * 60 + (slot + 1) * 10
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True, help="comma-separated run JSON files")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rows = set()
    for path in a.runs.split(","):
        run = json.load(open(path))
        period = run["split"]
        for sym, r in run["symbols"].items():
            for rule, alerts in r["alerts"].items():
                for date, slot, _ in alerts:
                    rows.add((rule, period, sym, date, time_ny(slot), slot))
    with open(a.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rule", "period", "symbol", "date", "time_ny", "slot"])
        for row in sorted(rows):
            w.writerow(row)
    print(f"{len(rows)} alerts -> {a.out}")


if __name__ == "__main__":
    main()
