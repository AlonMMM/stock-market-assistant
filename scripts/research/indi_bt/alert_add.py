"""V2: double the position on the first same-side volume alert after the entry (the user, 2026-10-25).

Tagging the champion's trades with the site's rvol-v6 alerts (alert_gate.py's port) showed that a same-side alert within
30 minutes of the entry marks the best group on both lists (fair 35% winners, +9,099 a trade; unseen 41%, +5,536), while
"no alert after the entry" is the loser pool (12% / 16% winners). Here the champion's own signals get a B minute: the
first same-side alert within W minutes after the signal. tiers.py tops the position up to B's size at that minute if the
option is above the entry cost and nothing was sold yet; with BT_RISK C 1% / B 2% the add equals the original premium.

  python3 alert_add.py signals [W...]   (from the repo root, BT_UNIVERSE=wide) -> s_sig_t18r15_aa<W>_<year>.csv
  python3 alert_add.py round [W...]     -> s_t18r15_aa<W>_<year>.<shard>_trades.csv (C 1%, B 2%, the champion's exits)
  python3 alert_add.py summary [W...]   -> champion vs the add, fair list and 151 unseen
"""
import csv, glob, json, os, statistics as st, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("BT_UNIVERSE", "wide")
from store import day, calendar
import alert_gate as ag

B = "data/local/x/bt"
YEARS = ("2024", "2025", "2026")
WINDOWS = [int(a) for a in sys.argv[2:]] or [30, 60]


def signals():
    cal = calendar(); wc = {}
    def W(sym, d):
        if (sym, d) not in wc: wc[(sym, d)] = ag.windows(day(sym, d))[0]
        return wc[(sym, d)]
    for y in YEARS:
        rows = list(csv.DictReader(open(f"{B}/s_sig_t18r15_{y}.csv")))
        out = {w: [] for w in WINDOWS}
        for r in rows:
            i = cal.index(r["date"]); m = int(r["minute"]); want = "up" if r["right"] == "C" else "down"
            al = ag.alerts(day(r["sym"], r["date"]), [W(r["sym"], d) for d in cal[i - 20:i]])
            for w in WINDOWS:
                k = next((k for k in range(m + 1, min(m + w, 389) + 1) if al[k] == want), None)
                out[w].append(dict(r, b_minute="" if k is None else k))
        for w in WINDOWS:
            with open(f"{B}/s_sig_t18r15_aa{w}_{y}.csv", "w") as f:
                wr = csv.DictWriter(f, fieldnames=list(out[w][0])); wr.writeheader(); wr.writerows(out[w])
            print(f"aa{w} {y}: {len(out[w])} signals, {sum(1 for r in out[w] if r['b_minute'] != '')} with a same-side alert within {w} min", flush=True)
        wc.clear()


def round_():
    from tiers_round import H, NIGHT, R
    env = dict(os.environ, BT_VARIANT="v2", BT_UNIVERSE="wide", BT_EXIT=json.dumps(dict(H, **NIGHT)), BT_RISK=json.dumps({"C": 0.01, "B": 0.02, "A": 0.02}))
    env.pop("BT_FLAT", None)
    jobs = []
    for w in WINDOWS:
        for y in YEARS:
            out = f"{B}/s_t18r15_aa{w}_{y}"
            if all(os.path.exists(f"{out}.{i}_trades.csv") for i in range(4)): continue
            for i in range(4):
                jobs.append((["node", "--env-file=.env", R, "tiers.py", f"{B}/s_sig_t18r15_aa{w}_{y}.csv", out, f"{i}/4"], f"{out}.{i}.log"))
    running = []
    while jobs or running:
        while jobs and len(running) < 8:
            args, log = jobs.pop(0)
            with open(log, "w") as f: running.append(subprocess.Popen(args, env=env, stdout=f, stderr=subprocess.STDOUT))
        running[0].wait(); running = [p for p in running if p.poll() is None]
    print("done", flush=True)


def summary():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    from score_sum import account
    news = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
    key = lambda t: (t["date"], t["sym"])
    def load(p):
        T = [t for f in glob.glob(f"{B}/{p}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
        nf.features(T); return sorted((t for t in T if news(t)), key=lambda t: (t["date"], int(t["minute"])))
    champ = load("s_t18r15"); cb = {key(t): t for t in champ}
    lists = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)]
    def line(lab, A):
        yr = {y: sorted(float(t["pnl"]) for t in A if t["date"][:4] == y) for y in YEARS}
        a1, d1 = account(A); a2, d2 = account(A, 0.02); pnl = [float(t["pnl"]) for t in A]
        print(f"| {lab} | {len(A)} | {100 * sum(x > 0 for x in pnl) / len(pnl):.0f}% | " + " / ".join(f"{st.fmean(v):+,.0f}" for v in yr.values())
              + " | " + " / ".join(f"{sum(v[:-5]) / 1e3:+,.0f}K" for v in yr.values()) + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |")
    for lname, lf in lists:
        print(f"\n### {lname}\n\n| Version | Trades | Winners | 2024 / 2025 / 2026 per trade | Without best 5 (24 / 25 / 26) | At 1% (+1% add) | At 2% (+2% add) |\n|---|---|---|---|---|---|---|")
        L = [t for t in champ if lf(t)]; line("champion", L)
        for w in WINDOWS:
            A = [t for t in load(f"s_t18r15_aa{w}") if lf(t)]
            if not A: continue
            line(f"double on a same-side alert within {w} min", A)
            added = [t for t in A if int(t["legs"]) > 1]
            base = [cb[key(t)] for t in added if key(t) in cb]
            print(f"  {len(added)} trades got the add ({100 * sum(float(t['pnl']) > 0 for t in added) / max(len(added), 1):.0f}% winners); the same trades without it: "
                  f"{st.fmean(float(t['pnl']) for t in base):+,.0f} a trade, with it {st.fmean(float(t['pnl']) for t in added):+,.0f} (per $10K of the first premium); "
                  f"the add leg alone: {st.fmean(float(t['pnl']) - float(cb[key(t)]['pnl']) for t in added if key(t) in cb):+,.0f} a trade, "
                  f"{100 * sum(float(t['pnl']) - float(cb[key(t)]['pnl']) > 0 for t in added if key(t) in cb) / max(len(base), 1):.0f}% positive")
            best = sorted(added, key=lambda t: -(float(t["pnl"]) - float(cb[key(t)]["pnl"])) if key(t) in cb else 0)[:5]
            print("  biggest adds: " + ", ".join(f"{t['sym']} {t['date']} {float(t['pnl']) - float(cb[key(t)]['pnl']):+,.0f}" for t in best))


if __name__ == "__main__":
    {"signals": signals, "round": round_, "summary": summary}[sys.argv[1]]()
