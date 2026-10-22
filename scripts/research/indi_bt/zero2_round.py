"""V2: the big 0DTE run. Breakout entries (zero2_signals.py) x exits that lock in winners during the day x delta x fill
timing. The same-day contract only, every exit checked on each 1-minute option bar, out by 15:30 New York.

  python3 zero2_round.py      (from the repo root) -> data/local/x/bt/z2_<entry>_<exit>_d<delta>_<fill>_<year>.<shard>_trades.csv
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tiers_round import H, R, B

N = dict(H, user_stop=None)
L5 = [[0.5, 0.1], [1.0, 0.5], [2.0, 1.2], [4.0, 2.5]]
EXITS = {
    "X1": dict(N, floor=-0.4),                                                     # -40% stop only
    "X2": dict(N, floor=-0.4, guard={"arm": 0.5, "trail": 0.3}),                  # after +50%, trail 30%
    "X3": dict(N, floor=-0.3, guard={"arm": 0.3, "trail": 0.2}),                  # after +30%, trail 20%
    "X4": dict(N, floor=-0.4, guard={"arm": 1.0, "trail": 0.4}),                  # after +100%, trail 40%
    "X5": dict(N, floor=-0.4, locks=L5),                                          # step locks
    "X6": dict(N, floor=-0.3, locks=[[0.3, 0.0], [0.6, 0.3], [1.0, 0.6], [2.0, 1.4]]),  # tighter step locks
    "X7": dict(N, floor=-0.4, takes=[[0.5, 1 / 3], [1.0, 1 / 3]], trail=0.3),     # thirds, the rest trails 30%
    "X8": dict(H, user_stop={"every": {"from": 5, "to": 60, "share": 0.5, "opt": -0.15}, "checks": [], "out": -0.4}, floor=-0.4, locks=L5),
    "X9": dict(N, floor=-0.4, locks=L5, time_stop={"min": 30, "need": 0.2}),      # out at 30 min unless up 20%
    "X10": dict(N, floor=-0.4, locks=L5, stock_stop="vwap"),                      # out when the stock falls back through VWAP
}
ENTRIES = ["E1", "E2", "E3", "E4", "E5", "E6"]
DELTAS = [0.15, 0.30, 0.45]
FILLS = ["close", "open"]


def main():
    jobs = []
    for e in ENTRIES:
        for x, X in EXITS.items():
            for d in DELTAS:
                for fill in FILLS:
                    env = dict(os.environ, BT_VARIANT="v2", BT_UNIVERSE="wide", BT_FLAT="1", BT_EXIT=json.dumps(X), BT_FILL=fill,
                               BT_CONTRACT=json.dumps({"dte_min": 0, "dte_max": 0, "delta": d}))
                    for y in ("2024", "2025", "2026"):
                        out = f"{B}/z2_{e}_{x}_d{int(d * 100)}_{fill}_{y}"
                        if all(os.path.exists(f"{out}.{i}_trades.csv") for i in range(4)): continue
                        for i in range(4):
                            jobs.append((["node", "--env-file=.env", R, "tiers.py", f"{B}/z2_sig_{e}_{y}.csv", out, f"{i}/4"], f"{out}.{i}.log", env))
    print(len(jobs), "jobs", flush=True)
    running = []
    while jobs or running:
        while jobs and len(running) < 8:
            args, log, env = jobs.pop(0)
            with open(log, "w") as f: running.append(subprocess.Popen(args, env=env, stdout=f, stderr=subprocess.STDOUT))
        running[0].wait(); running = [p for p in running if p.poll() is None]
    print("done", flush=True)


if __name__ == "__main__":
    main()
