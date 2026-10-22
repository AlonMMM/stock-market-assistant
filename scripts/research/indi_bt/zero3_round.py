"""V2: 0DTE in Indi's range. Breakout entries in the first hour or the last 90 minutes (zero3_signals.py), delta 0.20 /
0.25 (0.30 for reference), exits that lock in winners, fill on the breakout bar or the next open; out by 15:50 New York
(not 15:30, so late entries can work). The SPY filter and the lists are applied in zero3_sum.py.

  python3 zero3_round.py      (from the repo root) -> data/local/x/bt/z3_<entry>_<win>_<exit>_d<delta>_<fill>_<year>.<shard>_trades.csv
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tiers_round import H, R, B

N = dict(H, user_stop=None, expiry_last_minute=385)
EXITS = {
    "X1": dict(N, floor=-0.4),                                                     # -40% stop only
    "X5": dict(N, floor=-0.4, locks=[[0.5, 0.1], [1.0, 0.5], [2.0, 1.2], [4.0, 2.5]]),  # step locks
    "X7": dict(N, floor=-0.4, takes=[[0.5, 1 / 3], [1.0, 1 / 3]], trail=0.3),     # thirds, the rest trails 30%
    "X11": dict(H, expiry_last_minute=385, floor=-0.4, takes=[[0.5, 1 / 3], [1.0, 1 / 3]], trail=0.3,  # his way: out at -25% from minute 5, + thirds
                user_stop={"every": {"from": 5, "to": 400, "share": 1.0, "opt": -0.25}, "checks": [], "out": -0.4}),
}
ENTRIES = os.environ.get("ZR_ENTRIES", "E1,E2,E5,E6").split(",")
WINS = os.environ.get("ZR_WINS", "early,late").split(",")
DELTAS = [float(x) for x in os.environ.get("ZR_DELTAS", "0.20,0.25,0.30").split(",")]
FILLS = os.environ.get("ZR_FILLS", "close,open").split(",")
TAG = os.environ.get("Z_TAG", "")  # another stock list: its signals and results carry this tag
UNI = os.environ.get("BT_UNIVERSE", "wide")


def main():
    jobs = []
    for e in ENTRIES:
        for w in WINS:
            for x, X in EXITS.items():
                for d in DELTAS:
                    for fill in FILLS:
                        env = dict(os.environ, BT_VARIANT="v2", BT_UNIVERSE=UNI, BT_FLAT="1", BT_EXIT=json.dumps(X), BT_FILL=fill,
                                   BT_CONTRACT=json.dumps({"dte_min": 0, "dte_max": 0, "delta": d}))
                        for y in ("2024", "2025", "2026"):
                            out = f"{B}/z3{TAG}_{e}_{w}_{x}_d{int(d * 100)}_{fill}_{y}"
                            if all(os.path.exists(f"{out}.{i}_trades.csv") for i in range(4)): continue
                            for i in range(4):
                                jobs.append((["node", "--env-file=.env", R, "tiers.py", f"{B}/z3{TAG}_sig_{e}_{w}_{y}.csv", out, f"{i}/4"], f"{out}.{i}.log", env))
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
