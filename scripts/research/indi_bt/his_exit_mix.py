"""His entries (contract + minute, $10K) under exits built from two separate halves, 2024 - Oct 2026:
a loss side (how losers are cut) and a profit side (how winners are taken), every pair of them.

Loss side:   ours  = your stop (checks at 10 / 20 minutes, out at -30%)
             his   = like him: half at -20%, the rest at -40%
Profit side: eod      = sell all at 15:50 (what we do now)
             scratch  = after +25%, sell all if it comes back to the entry price
             night100 = hold overnight what is up >= +100% at 15:50 (next morning: half if it gaps our way, else all)
             q200     = sell a quarter at +200%, hold overnight if up >= +100%
             q100_200 = a quarter at +100% and at +200%, 40% trail on the rest, hold overnight if up >= +50%
             his      = scratch + q200 (his small and big winners)
             q200_keep = q200, and the next morning keep it all if it gaps our way

  python3 his_exit_mix.py [report]      (from the repo root; needs t_sig_his_<year>.csv)
"""
import json, os, statistics as st, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
B = "data/local/x/bt"
YEARS = ("2024", "2025", "2026")
BASE = {"cut1": -1.0, "floor": -1.0, "l2_on": False, "win_arm": 99, "takes": [], "fast_minutes": None, "trail": 1.0, "runner_stall_min": 999,
        "carry_min_gain": 99, "carry_range_pos": 0.0, "carry_min_dte": 1, "carry_no_friday": False, "carry_max_days": 2,
        "stock_stop": None, "user_stop": None, "roll": None}
LOSS = {"ours": {"user_stop": {"checks": [[10, 0.5], [20, 1.0]], "out": -0.30}},
        "his": {"cut1": -0.20, "cut1_share": 0.5, "cut1_confirm": 1, "min_hold": 0, "floor": -0.40}}
NIGHT = lambda g: {"carry_min_gain": g}
PROFIT = {"eod": {},
          "scratch": {"win_arm": 0.25},
          "night100": NIGHT(1.0),
          "q200": dict(NIGHT(1.0), takes=[[2.0, 0.25]]),
          "q100_200": dict(NIGHT(0.5), takes=[[1.0, 0.25], [2.0, 0.25]], trail=0.4),
          "his": dict(NIGHT(1.0), takes=[[2.0, 0.25]], win_arm=0.25),
          "q200_keep": dict(NIGHT(1.0), takes=[[2.0, 0.25]], gap_sell_share=0.0)}


def run():
    ps = []
    for ln, lo in LOSS.items():
        for pn, po in PROFIT.items():
            X = dict(BASE, **lo, **po)
            for y in YEARS:
                out = f"{B}/hm_{ln}_{pn}_{y}"
                env = dict(os.environ, BT_VARIANT="v2", BT_EXIT=json.dumps(X))
                ps.append(subprocess.Popen([sys.executable, os.path.join(HERE, "sim.py"), f"{B}/t_sig_his_{y}.csv", out], env=env,
                                           stdout=open(out + ".log", "w"), stderr=subprocess.STDOUT))
                if len(ps) >= 8:
                    for p in ps: p.wait()
                    ps = []
    for p in ps: p.wait()


def report():
    import report as R_
    print("| Loss side | Profit side | 2024 | 2025 | 2026 | 2025-26 per trade | 3 years | w/o best 5 |\n|---|---|---|---|---|---|---|---|")
    for ln in LOSS:
        for pn in PROFIT:
            c, allr, r56 = [], [], []
            for y in YEARS:
                T, S, _ = R_.load(f"{B}/hm_{ln}_{pn}_{y}"); ok = [t for t in T if t["status"] == "ok"]
                R = [R_.ret_at(S[t["_i"]], R_.SH) for t in ok]; allr += R
                if y != "2024": r56 += R
                c.append(f"{1e4*st.fmean(R):+,.0f}")
            s = sorted(allr)
            print(f"| {ln} | {pn} | " + " | ".join(c) + f" | {1e4*st.fmean(r56):+,.0f} | {1e4*sum(s)/1e3:+,.0f}K | {1e4*sum(s[:-5])/1e3:+,.0f}K |")


if __name__ == "__main__":
    if sys.argv[1:] != ["report"]: run()
    report()
