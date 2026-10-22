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
    "nt25": {"night_trail": 0.25},                           # carried day: the rest out 25% under the day's high
    "nt40": {"night_trail": 0.40},
    "nt50": {"night_trail": 0.50},
    "mall": {"gap_sell_share": 1.0},                         # morning gap our way: sell all, not half
    # half at the first minute the stock is against the entry, then the rest at +20 if still against
    "e1": {"user_stop": {"every": {"from": 1, "to": 10, "share": 0.5}, "checks": [[20, 1.0]], "out": -0.30}},
    "e2": {"user_stop": {"every": {"from": 1, "to": 20, "share": 0.5}, "checks": [[20, 1.0]], "out": -0.30}},
    "e3": {"user_stop": {"every": {"from": 1, "to": 5, "share": 0.5}, "checks": [[10, 0.5], [20, 1.0]], "out": -0.30}},
    # wait 5 minutes, then check every minute for the half
    "f1": {"user_stop": {"every": {"from": 5, "to": 20, "share": 0.5}, "checks": [[20, 1.0]], "out": -0.30}},
    "f2": {"user_stop": {"every": {"from": 5, "to": 20, "share": 0.5, "opt": -0.15}, "checks": [[20, 1.0]], "out": -0.30}},
    "f3": {"user_stop": {"every": {"from": 5, "to": 10, "share": 0.5}, "checks": [[20, 1.0]], "out": -0.30}},
    "f4": {"user_stop": {"every": {"from": 5, "to": 60, "share": 0.5, "opt": -0.15}, "checks": [], "out": -0.30}, "floor": -0.30},
    "t150_250": {"takes": [[1.5, 0.25], [2.5, 0.25]]},       # the user's: a quarter at +150%, a quarter at +250%, the rest as V1
    "t150_250_lock500": {"takes": [[1.5, 0.25], [2.5, 0.25]], "guard": {"arm": 5.0, "floor": 2.0}},  # + the guard
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
