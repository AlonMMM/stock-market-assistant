# Relax the plan burst (2026-11-07): rules that ADD alerts to today's burst check, side still within 30 s.
# The user: "not cancel the burst ... maybe go for a bigger time frame, maybe check somehow if there was a low,
# or it's only go in one direction". Rules set before the run; pool = WIDE (no cross / burst filter) plan trades
# with the side within 30 s that base (Volume 1.3.0) does not trade. Flat $2K a trade, tune = even ISO weeks.
import json, glob, datetime, sys, sqlite3, gzip, base64
from zoneinfo import ZoneInfo
S = sys.argv[1]
db = sqlite3.connect(f"{S}/d1.sqlite")
NY = ZoneInfo("America/New_York")
def load(v):
    m = {}
    for f in glob.glob(f"{S}/cross/{v}/parts/*.json"):
        for s in json.load(open(f))["signals"]:
            m[s["id"]] = s
    return m
def ret(s):
    t = s.get("trade")
    if not t: return None
    return (t["sell"] * 100 - 0.62) / (t["buy"] * 100 + 0.62) - 1
def half(d):
    return "tune" if datetime.date.fromisoformat(d).isocalendar()[1] % 2 == 0 else "check"
cache = {}
def bars(sym, date):
    k = (sym, date)
    if k not in cache:
        row = db.execute("select bars from minute_bars where key=? and date=?", (f"{sym}:sip:1Min:raw", date)).fetchone()
        out = {}
        if row:
            raw = row[0]
            rows = json.loads(gzip.decompress(base64.b64decode(raw[3:])) if raw.startswith("gz:") else raw)
            d = datetime.date.fromisoformat(date)
            open_ts = datetime.datetime(d.year, d.month, d.day, 9, 30, tzinfo=NY).timestamp()
            for ts, o, h, l, c, v in rows:
                out[int((ts - open_ts) // 60)] = (o, h, l, c, v)
        cache[k] = out
    return cache[k]
base, wide = load("base"), load("WIDE")
pool = []
miss = 0
for k, s in wide.items():
    r = ret(s)
    if s["kind"] != "plan" or r is None or ret(base.get(k, {})) is not None: continue
    t = s["trade"]
    if t["toSide"] > 30: continue
    sg = 1 if t["right"] == "C" else -1
    u, m = s["unit"], s["minute"]
    b, spy = bars(s["symbol"], s["date"]), bars("SPY", s["date"])
    if m not in b or not u:
        miss += 1; continue
    c = b[m][3]
    def mv(n, src=b):
        if m - n not in src or m not in src: return None
        return (src[m][3] / src[m - n][3] - 1)
    f = {}
    for n in (3, 5, 10):
        x = mv(n); f[f"b{n}"] = None if x is None else sg * x / u
    # one way over 5 min: the worst point against the side from the 5-min start
    if m - 5 in b:
        start = b[m - 5][3]
        lows = [b[i][2] for i in range(m - 4, m + 1) if i in b]
        highs = [b[i][1] for i in range(m - 4, m + 1) if i in b]
        worst = min(lows) if sg == 1 else max(highs)
        f["against5"] = sg * (worst / start - 1) / u
    else:
        f["against5"] = None
    sx = mv(3, spy)
    f["rel"] = None if (f["b3"] is None or sx is None) else f["b3"] - sg * sx / u
    day = [i for i in sorted(b) if 0 <= i <= m]
    f["day"] = sg * (c / b[day[0]][0] - 1) / u if day else None
    pv = sum(((b[i][1] + b[i][2] + b[i][3]) / 3) * b[i][4] for i in day); vol = sum(b[i][4] for i in day)
    f["vwap"] = sg * (c / (pv / vol) - 1) / u if vol else None
    pool.append(dict(h=half(s["date"]), r=r, sym=s["symbol"], date=s["date"], **f))
def ok(v, lo): return v is not None and v >= lo
rules = [
    ("A burst over 5 min >= 1.1", lambda p: ok(p["b5"], 1.1)),
    ("B burst over 10 min >= 1.1", lambda p: ok(p["b10"], 1.1)),
    ("C one way: 5 min >= 0.5, never > 0.25 against", lambda p: ok(p["b5"], 0.5) and ok(p["against5"], -0.25)),
    ("D burst minus SPY >= 1.1", lambda p: ok(p["rel"], 1.1)),
    ("E day agrees >= 1 unit, burst >= 0", lambda p: ok(p["day"], 1) and ok(p["b3"], 0)),
    ("F past VWAP >= 0.5 unit, burst >= 0", lambda p: ok(p["vwap"], 0.5) and ok(p["b3"], 0)),
]
def cell(ps):
    rs = sorted(p["r"] for p in ps)
    if not rs: return "0 trades"
    g = [f"{p['sym']} {p['date'][5:]} +{p['r']*100:.0f}%" for p in ps if p["r"] >= 3]
    return (f"{len(rs):4d} trades, win {sum(x > 0 for x in rs)/len(rs)*100:3.0f}%, median {rs[len(rs)//2]*100:+4.0f}%, "
            f"total {sum(rs)*2:+6.1f}K, non-giant {sum(x for x in rs if x < 3)*2:+6.1f}K, giants {len(g)} {'; '.join(g)}")
print(f"pool: {len(pool)} extra plan trades with the side within 30 s (no bars: {miss})")
for h in ("tune", "check"):
    print(f"  all extra, {h}: {cell([p for p in pool if p['h'] == h])}")
for name, rule in rules:
    print(f"\n{name}")
    for h in ("tune", "check"):
        print(f"  {h:5s}: {cell([p for p in pool if p['h'] == h and rule(p)])}")
