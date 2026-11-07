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
pool = []
for k, s in wide.items():
    r = ret(s)
    if s["kind"] != "plan" or r is None or ret(base.get(k, {})) is not None: continue
    t = s["trade"]
    pool.append((half(s["date"]), t["toSide"], s["burst"] if t["right"] == "C" else -s["burst"], r, s["symbol"], s["date"]))
def line(name, rs, gs):
    rs = sorted(rs)
    print(f"{name:34s} n={len(rs):4d} win={sum(x>0 for x in rs)/len(rs)*100:3.0f}% med={rs[len(rs)//2]*100:+4.0f}% total={sum(rs)*2:+7.1f}K nongiant={sum(x for x in rs if x<3)*2:+7.1f}K giants={len(gs)} {', '.join(gs)}")
for lim in [15, 30]:
    for h in ["tune", "check"]:
        sel = [p for p in pool if p[0] == h and p[1] <= lim]
        line(f"side <= {lim}s, any burst, {h}", [p[3] for p in sel], [f"{p[4]} {p[5]} +{p[3]*100:.0f}%" for p in sel if p[3] >= 3])
        for bn, bf in [("  burst toward >= 0", lambda b: b >= 0), ("  burst against", lambda b: b < 0)]:
            sub = [p for p in sel if bf(p[2])]
            line(bn, [p[3] for p in sub], [f"{p[4]} {p[5]}" for p in sub if p[3] >= 3])
