"""V2: rolling out on the champion (V1 signals, flat 1%, your stop + overnight hold, delta 0.15). When the stock comes
close to the strike fast, sell (part of) the contract and buy a further out-of-the-money one with the same dollars
the sold part cost; the profit stays banked. The new contract runs under the same exits and does not roll again.

  python3 roll_round.py [names...]      (from the repo root) -> data/local/x/bt/r_<name>_<year>.<shard>_trades.csv
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tiers_round import H, NIGHT, R, B

ROLLS = {  # name -> (roll rule, delta of the new contract)
    "n25_all_d15": ({"near": 0.25, "within": 60, "share": 1.0}, 0.15),
    "n25_all_d30": ({"near": 0.25, "within": 60, "share": 1.0}, 0.30),
    "n25_half_d30": ({"near": 0.25, "within": 60, "share": 0.5}, 0.30),
    "n50_all_d30": ({"near": 0.50, "within": 30, "share": 1.0}, 0.30),
    "atm_all_d15": ({"near": 0.0, "within": 120, "share": 1.0}, 0.15),
    "atm_all_d30": ({"near": 0.0, "within": 120, "share": 1.0}, 0.30),
}


def main():
    jobs = []
    for name in sys.argv[1:] or list(ROLLS):
        rule, d = ROLLS[name]
        env = dict(os.environ, BT_VARIANT="v2", BT_UNIVERSE="wide", BT_FLAT="1", BT_ROLL_DELTA=str(d), BT_ROLL_FUND="premium",
                   BT_EXIT=json.dumps(dict(H, **NIGHT, roll=dict(rule, rest_take=99))))
        for y in ("2024", "2025", "2026"):
            out = f"{B}/r_{name}_{y}"
            if all(os.path.exists(f"{out}.{i}_trades.csv") for i in range(4)): continue
            for i in range(4):
                jobs.append((["node", "--env-file=.env", R, "tiers.py", f"{B}/s_sig_v1_{y}.csv", out, f"{i}/4"], f"{out}.{i}.log", env))
    running = []
    while jobs or running:
        while jobs and len(running) < 8:
            args, log, env = jobs.pop(0)
            with open(log, "w") as f: running.append(subprocess.Popen(args, env=env, stdout=f, stderr=subprocess.STDOUT))
        running[0].wait(); running = [p for p in running if p.poll() is None]
    print("done", flush=True)


if __name__ == "__main__":
    main()
