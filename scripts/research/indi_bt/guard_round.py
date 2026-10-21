"""V2: a give-back guard on the champion (V1 signals, flat 1%, your stop + overnight hold, delta 0.15): once the option
has been up a lot, a big part of the gain is not given back. Also a ladder like his, with a trailing runner.

  python3 guard_round.py [names...]      (from the repo root) -> data/local/x/bt/g_<name>_<year>.<shard>_trades.csv
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tiers_round import H, NIGHT, R, B

GUARDS = {
    "none": {},                                               # the champion itself (for other deltas)
    "lock200_50": {"guard": {"arm": 2.0, "floor": 0.5}},     # up +200% once -> out if back to +50%
    "lock300_100": {"guard": {"arm": 3.0, "floor": 1.0}},    # up +300% once -> out if back to +100%
    "lock500_200": {"guard": {"arm": 5.0, "floor": 2.0}},
    "trail100_50": {"guard": {"arm": 1.0, "trail": 0.5}},    # up +100% once -> out 50% under the peak
    "trail200_40": {"guard": {"arm": 2.0, "trail": 0.4}},
    "trail300_50": {"guard": {"arm": 3.0, "trail": 0.5}},
    "ladder": {"takes": [[2.0, 0.25], [4.0, 0.25]], "trail": 0.4},  # a quarter at +200%, a quarter at +400%, the rest trails 40%
}


def main():
    jobs = []
    for name in sys.argv[1:] or list(GUARDS):
        env = dict(os.environ, BT_VARIANT="v2", **({"BT_CONTRACT": os.environ["BT_CONTRACT"]} if os.environ.get("BT_CONTRACT") else {}), BT_UNIVERSE="wide", BT_FLAT="1", BT_EXIT=json.dumps(dict(H, **NIGHT, **GUARDS[name])))
        for y in ("2024", "2025", "2026"):
            out = f"{B}/g{os.environ.get('BT_TAG', '')}_{name}_{y}"
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
