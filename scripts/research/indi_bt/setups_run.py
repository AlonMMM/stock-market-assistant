"""Build the pause / bigmove signals for 2024-2026 and run them, his entries and the bot's flat C entries,
each with your stop, and with your stop + the overnight hold for winners.

  python3 setups_run.py      (from the repo root)
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, "run.mjs"); B = "data/local/x/bt"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
H = {"carry_min_gain": 99, "win_arm": 99, "takes": [], "fast_minutes": None, "runner_stall_min": 999, "trail": 1.0, "cut1": -1.0, "floor": -1.0,
     "user_stop": {"checks": [[10, 0.5], [20, 1.0]], "out": -0.30}}
ON = dict(H, carry_min_gain=0.25)  # params defaults: stock at >= 0.9 of the day range, not Friday, >= 2 days left; 9:40 gap rule
jobs = []
for y, (a, b) in SPAN.items():
    for mode in ("pause", "bigmove"):
        out = f"{B}/s_sig_{mode}_{y}.csv"
        if not os.path.exists(out): subprocess.run([sys.executable, os.path.join(HERE, "setups.py"), a, b, mode, out], check=True)
    for name, script, src, ex, extra in (
            ("pause_stop", "sim.py", f"{B}/s_sig_pause_{y}.csv", H, {}), ("pause_on", "sim.py", f"{B}/s_sig_pause_{y}.csv", ON, {}),
            ("big_stop", "sim.py", f"{B}/s_sig_bigmove_{y}.csv", H, {}), ("big_on", "sim.py", f"{B}/s_sig_bigmove_{y}.csv", ON, {}),
            ("his_on", "sim.py", f"{B}/t_sig_his_{y}.csv", ON, {}), ("flat_on", "tiers.py", f"{B}/t_sig_tiers_{y}.csv", ON, {"BT_FLAT": "1"})):
        o = f"{B}/s_{name}_{y}"
        if all(os.path.exists(f"{o}.{i}_trades.csv") for i in range(4)): continue
        for i in range(4):
            jobs.append((["node", "--env-file=.env", R, script, src, o, f"{i}/4"], f"{o}.{i}.log", dict(os.environ, BT_VARIANT="v2", BT_EXIT=json.dumps(ex), **extra)))
running = []
while jobs or running:
    while jobs and len(running) < 8:
        args, log, env = jobs.pop(0); running.append(subprocess.Popen(args, env=env, stdout=open(log, "w"), stderr=subprocess.STDOUT))
    running[0].wait(); running = [p for p in running if p.poll() is None]
print("done")
