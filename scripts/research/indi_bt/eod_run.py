"""End-of-day entries held overnight: the bot's rule (all signals, and the top 2 a day) and his own
end-of-day entries, each with 1 night and with "let it run".

  python3 eod_run.py      (from the repo root; needs e_sig_eod_*, e_sig_eodtop2_*, e_sig_hiseod_* from eod.py)
"""
import json, os, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, "run.mjs"); B = "data/local/x/bt"
H = {"carry_min_gain": 99, "win_arm": 99, "takes": [], "fast_minutes": None, "runner_stall_min": 999, "trail": 1.0, "cut1": -1.0, "floor": -1.0,
     "user_stop": {"checks": [[10, 0.5], [20, 1.0]], "out": -0.30}}
CARRY = dict(H, carry_min_gain=-1.0, carry_range_pos=0.0, carry_min_dte=1, carry_no_friday=False)
EXITS = {"n1": dict(CARRY, carry_max_days=1), "run": CARRY}
jobs = []
for y in ("2024", "2025", "2026"):
    for sig in ("hold", "hiseod", "eodtop2", "eod"):
        for ex, X in EXITS.items():
            o = f"{B}/e_{sig}_{ex}_{y}"
            if all(os.path.exists(f"{o}.{i}_trades.csv") for i in range(4)): continue
            for i in range(4):
                jobs.append((["node", "--env-file=.env", R, "sim.py", f"{B}/e_sig_{sig}_{y}.csv", o, f"{i}/4"], f"{o}.{i}.log",
                             dict(os.environ, BT_VARIANT="v2", BT_EXIT=json.dumps(X))))
running = []
while jobs or running:
    while jobs and len(running) < 8:
        a, log, env = jobs.pop(0); running.append(subprocess.Popen(a, env=env, stdout=open(log, "w"), stderr=subprocess.STDOUT))
    running[0].wait(); running = [p for p in running if p.poll() is None]
print("done")
