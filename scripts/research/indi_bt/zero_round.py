"""V2: a 0DTE strategy search. Entries from zero_signals.py (09:40-12:30 New York), the same-day contract only, exits
checked on every 1-minute option bar, no overnight hold (0DTE), everything out by 15:30 New York.

  python3 zero_round.py      (from the repo root) -> data/local/x/bt/z_<entry>_<exit>_d<delta>_<year>.<shard>_trades.csv
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tiers_round import H, R, B

NO_USER = dict(H, user_stop=None)
EXITS = {
    "s40t30": dict(NO_USER, floor=-0.4, guard={"arm": 0.5, "trail": 0.3}),   # option -40% out; after +50%, out 30% under the peak
    "s30t25": dict(NO_USER, floor=-0.3, guard={"arm": 0.3, "trail": 0.25}),  # tighter
    "half100": dict(NO_USER, floor=-0.5, takes=[[1.0, 0.5]], trail=0.3),       # half at +100%, the rest trails 30%; -50% out
    "user_t35": dict(H, guard={"arm": 0.5, "trail": 0.35}),                    # your stop (stock checks) + trail after +50%
    # wait 5 minutes, then every minute: half out on the option's own drop (F4) or the stock against (F1)
    "f4": dict(H, user_stop={"every": {"from": 5, "to": 60, "share": 0.5, "opt": -0.15}, "checks": [], "out": -0.30}, floor=-0.30),
    "f4t30": dict(H, user_stop={"every": {"from": 5, "to": 60, "share": 0.5, "opt": -0.15}, "checks": [], "out": -0.30}, floor=-0.30,
                  guard={"arm": 0.5, "trail": 0.3}),
    "f1t30": dict(H, user_stop={"every": {"from": 5, "to": 20, "share": 0.5}, "checks": [[20, 1.0]], "out": -0.30}, guard={"arm": 0.5, "trail": 0.3}),
}
ENTRIES = os.environ.get("ZR_ENTRIES", "v1,low,v1_bo,low_bo").split(",")
DELTAS = [float(x) for x in os.environ.get("ZR_DELTAS", "0.15,0.30").split(",")]
ONLY = os.environ.get("ZR_EXITS")


def main():
    jobs = []
    for e in ENTRIES:
        for x, X in EXITS.items():
            if ONLY and x not in ONLY.split(","): continue
            for d in DELTAS:
                env = dict(os.environ, BT_VARIANT="v2", BT_UNIVERSE="wide", BT_FLAT="1", BT_EXIT=json.dumps(X),
                           BT_CONTRACT=json.dumps({"dte_min": 0, "dte_max": 0, "delta": d}))
                for y in ("2024", "2025", "2026"):
                    out = f"{B}/z_{e}_{x}_d{int(d * 100)}_{y}"
                    if all(os.path.exists(f"{out}.{i}_trades.csv") for i in range(4)): continue
                    for i in range(4):
                        jobs.append((["node", "--env-file=.env", R, "tiers.py", f"{B}/z_sig_{e}_{y}.csv", out, f"{i}/4"], f"{out}.{i}.log", env))
    running = []
    while jobs or running:
        while jobs and len(running) < 8:
            args, log, env = jobs.pop(0)
            with open(log, "w") as f: running.append(subprocess.Popen(args, env=env, stdout=f, stderr=subprocess.STDOUT))
        running[0].wait(); running = [p for p in running if p.poll() is None]
    print("done", flush=True)


if __name__ == "__main__":
    main()
