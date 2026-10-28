"""What the V2 rules would have bought on recent days: t >= 1.8, day volume >= 1.5x, the news filter, delta 0.15,
your stop + the overnight hold. NOT the live 2.7 (2026-10-28): its exits are the older ones (10-minute half, 20-minute
rest, -30% stop, overnight from +100%), with no bonus entry, early entry, rest stop, strength-gone sale or pyramid; the
review judges live trades against replay_days.sh (the live code) and uses this for its skips and as the research line. On the bot's core list (config/bot-universe.json) and the user's favorites.
Fetches the days first (stocks, pre-market; option bars as the picker needs them).

  node --env-file=.env scripts/research/indi_bt/run.mjs week.py <first day> <last day>   (from the repo root)
"""
import datetime as dt, json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
from store import P, fetch_bars, calendar
from fetch_context import pre

A, Z = sys.argv[1], sys.argv[2]
CORE = json.loads(subprocess.run(["git", "show", "origin/main:config/bot-universe.json"], capture_output=True, text=True, check=True).stdout)["symbols"]
FAV = [s for s in P["universe_fav"] if s not in CORE]
SYMS = ["SPY"] + CORE + FAV
start = (dt.date.fromisoformat(A) - dt.timedelta(days=45)).isoformat()
for i in range(0, len(SYMS), 50):
    fetch_bars("stocks", SYMS[i:i + 50], start, Z, key=f"week|{','.join(SYMS[i:i + 50])}|{start}|{Z}")
    pre(SYMS[i:i + 50], start, Z)

import sim, tune_signals as ts, news_filter as nf
from tiers_round import H, NIGHT
ts.SPAN = {"w": (A, Z)}; ts.RULES = {"t18r15": (1.8, 1.5, None)}
sim.X.update(dict(H, **NIGHT))
CAL = calendar()
sig = [r for s in CORE + FAV for r in ts.stock(s)["t18r15"]]
nf.CAL[:] = CAL; nf.IDX.clear(); nf.IDX.update({d: i for i, d in enumerate(CAL)})
nf.features(sig)
out = []
for t in sorted(sig, key=lambda r: (r["date"], r["minute"])):
    row = dict(t, list="core" if t["sym"] in CORE else "favorites")
    if t["e_next"] == 0: row["status"] = "skipped: earnings reaction day"
    elif t["pre_rvol"] is not None and t["pre_rvol"] >= 4: row["status"] = f"skipped: pre-market volume {t['pre_rvol']:.1f}x"
    else:
        picked, why = sim.pick(t["sym"], t["date"], t["minute"], t["right"], float(t["price"]))
        if not picked: row["status"] = f"no contract: {why}"
        else:
            sym, exp, k, dl, px, v30, iv = picked
            cost, steps, flag = sim.walk(t["sym"], t["date"], t["minute"], t["right"], sym, exp, CAL)
            if cost is None: row["status"] = "no fill"
            else:
                sold = sum(s[3] for s in steps if s[2] == "sell")
                row.update(status="bought", contract=sym, expiry=exp, strike=k, delta=round(dl, 3), cost=round(cost, 2),
                           steps=";".join(f"{s[0]} {s[1]} {s[2]} {s[3]:.2f} @{s[4]:.2f} {s[5]}" for s in steps[1:]),
                           ret=round(sim.result(cost, steps), 4) if sold >= 0.999 else None, open_share=round(1 - sold, 2),
                           next_report=t["e_next"])
    out.append(row)
json.dump(out, open(f"data/local/x/bt/week_{A}_{Z}.json", "w"), default=str, indent=1)
print(len(out), "signals")
