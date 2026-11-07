import json, glob, datetime, sys
S = sys.argv[1]
def load(v):
    m = {}
    for f in glob.glob(f"{S}/{v}/parts/*.json"):
        for s in json.load(open(f))["signals"]:
            m[s["id"]] = s
    return m
def ret(s):
    t = s.get("trade")
    if not t: return None
    return (t["sell"] * 100 - 0.62) / (t["buy"] * 100 + 0.62) - 1
def half(d):
    return "tune" if datetime.date.fromisoformat(d).isocalendar()[1] % 2 == 0 else "check"
base, wide = load("base"), load("WIDE")
ex = next(iter(wide.values()))
groups = {}
for k, s in wide.items():
    r = ret(s)
    if s["kind"] != "plan" or r is None or ret(base.get(k, {})) is not None: continue
    t = s["trade"]
    toward = s["burst"] if t["right"] == "C" else -s["burst"]
    exp = t.get("expiry"); same_week = False
    if exp:
        d0 = datetime.date.fromisoformat(s["date"]); d1 = datetime.date.fromisoformat(exp)
        same_week = (d1 - d0).days < 7 and d1.isocalendar()[1] == d0.isocalendar()[1]
    need = 2.5 if same_week else 1.1
    slow = t["toSide"] > 15
    weak = toward < need
    if slow and weak: g = "both"
    elif slow: g = "side too slow only"
    elif weak: g = "burst too weak only"
    else: g = "passes both (other reason)"
    groups.setdefault((g, half(s["date"])), []).append(r)
for g in ["side too slow only", "burst too weak only", "both", "passes both (other reason)"]:
    for h in ["tune", "check"]:
        rs = sorted(groups.get((g, h), []))
        if not rs: print(g, h, 0); continue
        print(f"{g:28s} {h:5s} n={len(rs):4d} win={sum(x>0 for x in rs)/len(rs)*100:3.0f}% med={rs[len(rs)//2]*100:+4.0f}% total={sum(rs)*2:+7.1f}K nongiant={sum(x for x in rs if x<3)*2:+7.1f}K giants={sum(x>=3 for x in rs)}")
