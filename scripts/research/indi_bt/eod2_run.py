"""V2: the end-of-day rules (eod2.py signals) through the options, 1 night, as his end-of-day entries were run
(eod_run.py "n1": always carried at 15:50, next morning half on a gap our way, else all). Delta 0.15, 191 stocks.

  python3 eod2_run.py [rules...]      (from the repo root) -> data/local/x/bt/e2_<rule>_<year>.<shard>_trades.csv
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, "run.mjs"); B = "data/local/x/bt"
H = {"carry_min_gain": 99, "win_arm": 99, "takes": [], "fast_minutes": None, "runner_stall_min": 999, "trail": 1.0, "cut1": -1.0, "floor": -1.0,
     "user_stop": {"checks": [[10, 0.5], [20, 1.0]], "out": -0.30}}
N1 = dict(H, carry_min_gain=-1.0, carry_range_pos=0.0, carry_min_dte=1, carry_no_friday=False, carry_max_days=1)
ENV = dict(os.environ, BT_VARIANT="v2", BT_UNIVERSE="wide", BT_EXIT=json.dumps(N1))

jobs = []
for rule in sys.argv[1:] or ["g2", "h2", "e2"]:
    for y in ("2024", "2025", "2026"):
        o = f"{B}/e2_{rule}_{y}"
        if all(os.path.exists(f"{o}.{i}_trades.csv") for i in range(4)): continue
        for i in range(4):
            jobs.append((["node", "--env-file=.env", R, "sim.py", f"{B}/e2_sig_{rule}_{y}.csv", o, f"{i}/4"], f"{o}.{i}.log"))
running = []
while jobs or running:
    while jobs and len(running) < 6:
        a, log = jobs.pop(0)
        with open(log, "w") as f: running.append(subprocess.Popen(a, env=ENV, stdout=f, stderr=subprocess.STDOUT))
    running[0].wait(); running = [p for p in running if p.poll() is None]
print("done")
