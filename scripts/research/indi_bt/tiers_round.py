"""One round of C / B / A tests, against his own entries, for 2024, 2025 and 2026.

  python3 tiers_round.py [narrow|wide] [years...]     (run from the repo root; BT_UNIVERSE follows the first arg)

Per year: tier signals (signals.py tiers), derived A-only signal files, his entries (controls.py his), then
every run below with your stop (half at 10 min / rest at 20 min if against, all out at -30%), 4 shards each,
8 processes at a time. Output prefix data/local/x/bt/<tag>_<run>_<year>; finished runs are skipped.
"""
import csv, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, "run.mjs")
B = "data/local/x/bt"
UNI = sys.argv[1] if len(sys.argv) > 1 else "narrow"
YEARS = sys.argv[2:] or ["2024", "2025", "2026"]
TAG = ("t" if UNI == "narrow" else "w") + os.environ.get("BT_TAG", "")  # BT_TAG + BT_TIERS: a variant of the tier conditions
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
ENV = dict(os.environ, BT_VARIANT="v2", **({"BT_UNIVERSE": "wide"} if UNI == "wide" else {}))

H = {"carry_min_gain": 99, "win_arm": 99, "takes": [], "fast_minutes": None, "runner_stall_min": 999, "trail": 1.0, "cut1": -1.0, "floor": -1.0,
     "user_stop": {"checks": [[10, 0.5], [20, 1.0]], "out": -0.30}}
NIGHT = dict(carry_min_gain=1.0, carry_range_pos=0.0, carry_min_dte=1, carry_no_friday=False, carry_max_days=2)  # hold winners up >= +100% overnight
roll = lambda gain, within, cap=5.0: dict(H, roll={"gain": gain, "within": within, "share": 0.5, "rest_take": cap})
# name -> (script, signal file kind, exit overrides, extra env)
RUNS = {
    "full":       ("tiers.py", "tiers", roll(3.0, 60), {}),
    "noroll":     ("tiers.py", "tiers", H, {}),
    "flat":       ("tiers.py", "tiers", H, {"BT_FLAT": "1"}),
    "roll100_30": ("tiers.py", "tiers", roll(1.0, 30), {}),
    "roll200_60": ("tiers.py", "tiers", roll(2.0, 60), {}),
    "roll300_120": ("tiers.py", "tiers", roll(3.0, 120), {}),
    "roll100_30_run": ("tiers.py", "tiers", roll(1.0, 30, 999), {}),   # the rest after a roll runs (no +500% take)
    "roll200_60_run": ("tiers.py", "tiers", roll(2.0, 60, 999), {}),
    "astart":     ("tiers.py", "astart", H, {}),          # only days where A is true at the first minute, 3%
    "astart_roll": ("tiers.py", "astart", roll(2.0, 60), {}),
    "astart_roll_run": ("tiers.py", "astart", roll(2.0, 60, 999), {}),
    "atA":        ("tiers.py", "atA", H, {}),             # enter at the first A minute, whenever it comes, 3%
    "his":        ("sim.py", "his", H, {}),
    "flat_n100":  ("tiers.py", "tiers", dict(H, **NIGHT), {"BT_FLAT": "1"}),          # flat + hold winners up >= +100% overnight
    "flat_q200k": ("tiers.py", "tiers", dict(H, **NIGHT, takes=[[2.0, 0.25]], gap_sell_share=0.0), {"BT_FLAT": "1"}),  # + a quarter at +200%, keep the rest on a good gap               # his entries and contracts, same exits, $10K each
}
for _d in (10, 20, 25, 30, 40):  # the flat entries at other contract deltas (default 0.15), both exits
    _c = {"BT_FLAT": "1", "BT_CONTRACT": json.dumps({"delta": _d / 100})}
    RUNS[f"flat_d{_d}"] = ("tiers.py", "tiers", H, _c)
    RUNS[f"flat_n100_d{_d}"] = ("tiers.py", "tiers", dict(H, **NIGHT), _c)


def sh(args, log, env=ENV):
    with open(log, "w") as f: return subprocess.Popen(args, env=env, stdout=f, stderr=subprocess.STDOUT)


def signals(y):
    a, b = SPAN[y]
    src = f"{B}/{TAG}_sig_tiers_{y}.csv"
    if not os.path.exists(src):
        sh(["python3", os.path.join(HERE, "signals.py"), a, b, "tiers"], f"{B}/{TAG}_tiers{y}.log", dict(ENV, BT_SIG_OUT=src)).wait()
    sys.path.insert(0, HERE)
    if UNI == "wide": os.environ["BT_UNIVERSE"] = "wide"
    from store import day
    rows = list(csv.DictReader(open(src)))
    astart = [r for r in rows if r["a_minute"] == r["minute"]]
    atA = []
    for r in rows:
        if r["a_minute"] == "": continue
        m = int(r["a_minute"]); px = [x[4] for x in day(r["sym"], r["date"]) if x[0] <= m]
        if px: atA.append(dict(r, minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}", price=px[-1], b_minute="", a_minute=m))
    for kind, data in (("astart", astart), ("atA", atA)):
        with open(f"{B}/{TAG}_sig_{kind}_{y}.csv", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(data)
    his = f"{B}/{TAG}_sig_his_{y}.csv"
    base_his = f"{B}/{TAG[0]}_sig_his_{y}.csv"
    if not os.path.exists(his) and os.path.exists(base_his): import shutil; shutil.copy(base_his, his)
    if not os.path.exists(his):
        sh(["python3", os.path.join(HERE, "controls.py"), "his", a, b, his], his + ".log").wait()


def main():
    for y in YEARS: signals(y)
    jobs = []
    only = os.environ.get("BT_RUNS", "").split(",") if os.environ.get("BT_RUNS") else None
    for name, (script, kind, ex, extra) in RUNS.items():
        if only and name not in only: continue
        for y in YEARS:
            out = f"{B}/{TAG}_{name}_{y}"
            if all(os.path.exists(f"{out}.{i}_trades.csv") for i in range(4)): continue
            for i in range(4):
                jobs.append((["node", "--env-file=.env", R, script, f"{B}/{TAG}_sig_{kind}_{y}.csv", out, f"{i}/4"],
                             f"{out}.{i}.log", dict(ENV, BT_EXIT=json.dumps(ex), **extra)))
    running = []
    while jobs or running:
        while jobs and len(running) < 8:
            args, log, env = jobs.pop(0); running.append(sh(args, log, env))
        running[0].wait(); running = [p for p in running if p.poll() is None]
    print(UNI, "done", flush=True)


if __name__ == "__main__":
    main()
