"""V2: the score rules (score_signals.py) through the V1 trade: flat 1%, your stop + the overnight hold, delta 0.15.

  python3 score_round.py [rules...]     (from the repo root) -> data/local/x/bt/s_<rule>_<year>.<shard>_trades.csv
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tiers_round import H, NIGHT, R, B

RULES = sys.argv[1:] or ["t3r1", "t25r12", "t15r25", "s20", "s25", "s30"]
ENV = dict(os.environ, BT_VARIANT="v2", BT_UNIVERSE="wide", BT_FLAT="1", BT_EXIT=json.dumps(dict(H, **NIGHT, **json.loads(os.environ.get("BT_EXIT_EXTRA", "{}")))),
           **({"BT_CONTRACT": os.environ["BT_CONTRACT"]} if os.environ.get("BT_CONTRACT") else {}))
TAG = os.environ.get("BT_TAG", "")


def main():
    jobs = []
    for rule in RULES:
        for y in ("2024", "2025", "2026"):
            out = f"{B}/s{TAG}_{rule}_{y}"
            if all(os.path.exists(f"{out}.{i}_trades.csv") for i in range(4)): continue
            for i in range(4):
                jobs.append((["node", "--env-file=.env", R, "tiers.py", f"{B}/s_sig_{rule}_{y}.csv", out, f"{i}/4"], f"{out}.{i}.log"))
    running = []
    while jobs or running:
        while jobs and len(running) < 8:
            args, log = jobs.pop(0)
            with open(log, "w") as f: running.append(subprocess.Popen(args, env=ENV, stdout=f, stderr=subprocess.STDOUT))
        running[0].wait(); running = [p for p in running if p.poll() is None]
    print("done", flush=True)


if __name__ == "__main__":
    main()
