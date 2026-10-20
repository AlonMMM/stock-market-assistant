"""His own entries (contract + minute) run through every exit version tested on the bot, 2024-2026, $10K each.

  python3 his_exits.py     (from the repo root; needs data/local/x/bt/t_sig_his_<year>.csv from tiers_round.py)
"""
import json, os, subprocess, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
B = "data/local/x/bt"
H = {"carry_min_gain": 99, "win_arm": 99, "takes": [], "fast_minutes": None, "runner_stall_min": 999, "trail": 1.0}
CHK = lambda out: {"checks": [[10, 0.5], [20, 1.0]], "out": out}
TAKES = {"takes": [[1.0, 0.25], [3.0, 0.25]], "fast_minutes": 10, "fast_takes": [[2.0, 0.25], [3.0, 0.25]], "trail": 0.4, "runner_stall_min": 20, "win_arm": 0.25}
V = {
    "nostop": dict(H, cut1=-1.0, floor=-1.0),
    "rules": {"carry_min_gain": 99},
    "opt30": dict(H, cut1=-1.0, floor=-0.30),
    "vwap": dict(H, cut1=-1.0, floor=-1.0, stock_stop="vwap"),
    "prev": dict(H, cut1=-1.0, floor=-1.0, stock_stop="prev"),
    "chk30": dict(H, cut1=-1.0, floor=-1.0, user_stop=CHK(-0.30)),
    "chk35": dict(H, cut1=-1.0, floor=-1.0, user_stop=CHK(-0.35)),
    "chk35_takes": dict(H, cut1=-1.0, floor=-1.0, user_stop=CHK(-0.35), **TAKES),
}
if __name__ == "__main__":
    ps = []
    for name, ov in V.items():
        for y in ("2024", "2025", "2026"):
            out = f"{B}/hx_{name}_{y}"
            env = dict(os.environ, BT_VARIANT="v2", BT_EXIT=json.dumps(ov))
            ps.append(subprocess.Popen([sys.executable, os.path.join(HERE, "sim.py"), f"{B}/t_sig_his_{y}.csv", out], env=env,
                                       stdout=open(out + ".log", "w"), stderr=subprocess.STDOUT))
        if len(ps) >= 8:
            for p in ps: p.wait()
            ps = []
    for p in ps: p.wait()
    import report
    print("| Exit | 2024 | 2025 | 2026 |\n|---|---|---|---|")
    for name in V:
        c = []
        for y in ("2024", "2025", "2026"):
            T, S, _ = report.load(f"{B}/hx_{name}_{y}"); ok = [t for t in T if t["status"] == "ok"]
            R = sorted(report.ret_at(S[t["_i"]], report.SH) for t in ok)
            c.append(f"{1e4*st.fmean(R):+,.0f} ({len(R)}; w/o best 5 {1e4*sum(R[:-5])/1e3:+,.0f}K)")
        print(f"| {name} | " + " | ".join(c) + " |")
