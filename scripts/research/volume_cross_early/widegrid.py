# The slow plan alerts as trades (WIDE: plan cross within 300 s, no burst filter), not in base,
# sliced by time to the side x burst toward the side, then by time of day; tune and check, flat $2K a trade.
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
    if not t:
        return None
    return (t["sell"] * 100 - 0.62) / (t["buy"] * 100 + 0.62) - 1


def half(d):
    return "tune" if datetime.date.fromisoformat(d).isocalendar()[1] % 2 == 0 else "check"


base, wide = load("base"), load("WIDE")
pool = []
for k, s in wide.items():
    r = ret(s)
    if s["kind"] != "plan" or r is None or ret(base.get(k, {})) is not None:
        continue
    t = s["trade"]
    toward = s["burst"] if t["right"] == "C" else -s["burst"]
    pool.append(dict(h=half(s["date"]), r=r, to=t["toSide"], b=toward, m=s["minute"], sym=s["symbol"], date=s["date"], buy=t["buy"]))


def cell(rs):
    if not rs:
        return "      –"
    rs = sorted(rs)
    med = rs[len(rs) // 2]
    ng = sum(x for x in rs if x < 3) * 2
    g = sum(x >= 3 for x in rs)
    return f"{len(rs):4d} {med*100:+4.0f}% ng {ng:+6.1f}K g{g}"


def grid(name, rows, cols, rkey, ckey):
    print(f"\n## {name}")
    for h in ["tune", "check"]:
        print(f"\n{h}: n, median, non-giant sum (flat $2K), giants")
        print("".ljust(14) + "".join(c[0].ljust(30) for c in cols))
        for rn, rf in rows:
            line = rn.ljust(14)
            for cn, cf in cols:
                line += cell([p["r"] for p in pool if p["h"] == h and rf(p[rkey]) and cf(p[ckey])]).ljust(30)
            print(line)


print("pool (plan, traded in WIDE, not in base):", {h: cell([p["r"] for p in pool if p["h"] == h]) for h in ["tune", "check"]})
print("buys under $0.05:", sum(p["buy"] < 0.05 for p in pool))
to_rows = [("15-30 s", lambda v: v <= 30), ("30-60 s", lambda v: 30 < v <= 60), ("60-120 s", lambda v: 60 < v <= 120), ("120-300 s", lambda v: 120 < v <= 300), ("300-600 s", lambda v: v > 300)]
b_cols = [("burst <0 (against)", lambda v: v < 0), ("0-0.5", lambda v: 0 <= v < 0.5), ("0.5-1.1", lambda v: 0.5 <= v < 1.1), (">=1.1", lambda v: v >= 1.1)]
grid("time to side x burst toward the side", to_rows, b_cols, "to", "b")
tod = [("09:30-10:30", lambda m: m < 60), ("10:30-12:00", lambda m: 60 <= m < 150), ("12:00-14:00", lambda m: 150 <= m < 270), ("14:00-16:00", lambda m: m >= 270)]
all_cols = [("all", lambda v: True), ("burst >= 0", lambda v: v >= 0)]
grid("time of day (NY)", tod, all_cols, "m", "b")

for h in ["tune", "check"]:
    rs = [p["r"] for p in pool if p["h"] == h]
    g = sorted([p for p in pool if p["h"] == h and p["r"] >= 3], key=lambda p: -p["r"])
    print(h, f"all {len(rs)} trades, total incl. giants {sum(rs)*2:+.1f}K, winners {sum(r > 0 for r in rs)} ({sum(r > 0 for r in rs)/len(rs)*100:.0f}%)",
          "giants:", ", ".join(f"{p['sym']} {p['date']} +{p['r']*100:.0f}%" for p in g))
