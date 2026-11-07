# How far the stock went against the trade in the 30-minute grace (minute closes, units), and how those trades ended.
import json, glob, datetime, sys
sys.argv = [sys.argv[0], sys.argv[1]]
exec(open(sys.argv[1] + "/exitwalk.py").read().split("def walk(")[0].replace("R = sys.argv[1]", "R = sys.argv[1] + '/cross'"))
half = lambda d: "tune" if datetime.date.fromisoformat(d).isocalendar()[1] % 2 == 0 else "check"
rows = []
for f in glob.glob(f"{R}/BW10/parts/*.json"):
    for s in json.load(open(f))["signals"]:
        t = s.get("trade")
        if not t: continue
        sg = 1 if t["right"] == "C" else -1
        c = stock(s["symbol"], s["date"]); b0 = t["sideSecond"] // 60
        adv = max([-sg * (c[m] / t["stockIn"] - 1) / s["unit"] for m in range(b0 + 1, b0 + 31) if m in c] or [0])
        r = (t["sell"] * 100 - 0.62) / (t["buy"] * 100 + 0.62) - 1
        rows.append((half(s["date"]), adv, r))
for h in ("tune", "check"):
    print(h)
    for lo, hi in ((-9, 0.5), (0.5, 1), (1, 1.5), (1.5, 2), (2, 99)):
        rs = sorted(r for hh, a, r in rows if hh == h and lo <= a < hi)
        if rs: print(f"  against {lo:>4}-{hi:<3} units: {len(rs):3d} trades, win {sum(x>0 for x in rs)/len(rs)*100:3.0f}%, median {rs[len(rs)//2]*100:+4.0f}%, giants {sum(x>=3 for x in rs)}, ended -50% or worse {sum(x<=-0.5 for x in rs)}")
