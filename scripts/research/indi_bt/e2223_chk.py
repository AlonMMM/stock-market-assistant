import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import size_volume as SV
Y = os.environ["Y"]; sys.argv = [sys.argv[0], Y]
import dbx22 as DX, add_small as AS, sim, opt_spread as OS
from d2_failed_break import CHAMP
for t in DX.signals():
    if (t["date"], t["sym"], t["kind"]) != tuple(os.environ["K"].split(",")): continue
    m = int(t["minute"]); c = DX.pick(t)
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], DX.CAL)
    rcost, _ = OS.price(steps, c[0], cost, "bid")
    print(t["sym"], t["date"], "minute", m, c[0], "paid", rcost, "rvol", t["c_rvol"], "t", t["c_t"])
    for k, ov in (("2.10", None), ("e", AS.over_for("e", "main", float(t["c_rvol"])))):
        s_ = AS.walk(t, m, c, rcost, ov); _, real = OS.price(s_, c[0], rcost, "bid")
        print("==", k, ov); [print("  ", x[:6]) for x in real[:14]]
