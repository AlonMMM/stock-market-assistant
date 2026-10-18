# Turns fills.csv into per-trade action timelines (open / add / trim / re-enter / close),
# grouping same-side fills at most 45 s apart into one action, and attaches his posts
# about that ticker within 15 minutes of each action. Times: order submit time, ET.
import csv, json, sys, collections, datetime as dt
d = sys.argv[1]
fills = list(csv.DictReader(open(f"{d}/fills.csv")))
for f in fills: f["strike"] = f"{float(f['strike']):g}"
LAST_DAY = max(f["date"] for f in fills)
def mult(u, right):
    if right == "S": return 1  # shares
    if u.startswith("GC "): return 100
    return 1000 if "FOP" in u else 100
key = lambda f: (f["account"], f["underlying"], f["expiry"], f["strike"], f["right"])
# Rows without a time (aggregates from the Portfolio screen) sort at the end of the day.
def ts(f): return dt.datetime.fromisoformat(f"{f['date']}T{f['time_et'] or '15:59:59'}")
from zoneinfo import ZoneInfo
NY = ZoneInfo("America/New_York")
# His posts, UTC -> ET (EDT, UTC-4, valid through Nov 1).
posts = []
for th in json.load(open(f"{d}/threads.json")):
    root = th["posts"][0]["text"]
    for p in th["posts"]:
        t = dt.datetime.fromisoformat(p["time"].replace("Z", "+00:00")).astimezone(NY).replace(tzinfo=None)
        # Thread updates rarely repeat the ticker: match them on the thread's first post too.
        posts.append((t, p["text"].replace("\n", " ").strip(), p["id"], root + " " + p["text"]))
alias = {"SPXW": ["SPX", "SPXW", "ספי"], "CL FOP ML2": ["CL", "נפט"], "ZB FOP HB1": ["ZB", "אג"], "IBIT": ["IBIT", "ביטקוין"],
         "TSLA": ["TSLA", "טסלה"], "AAPL": ["AAPL", "אפל"], "NVDA": ["NVDA", "אנבידיה", "אנוידיה"], "META": ["META", "מטא"],
         "MU": ["MU ", "$MU", "מיקרון"], "MSFT": ["MSFT", "מיקרוסופט"], "AVGO": ["AVGO", "ברודקום"], "ORCL": ["ORCL", "אורקל"],
         "MRNA": ["MRNA", "מודרנה"], "CRWD": ["CRWD", "קראודסטרייק"], "GOOGL": ["GOOGL", "גוגל"],
         "AMZN": ["AMZN", "אמזון"], "PLTR": ["PLTR", "פלנטיר"], "SNDK": ["SNDK", "סנדיסק"], "MSTR": ["MSTR", "מייקל", "סטרטג"],
         "SLV": ["SLV", "כסף"], "GLD": ["GLD", "זהב"], "TLT": ["TLT", "אג"], "NDXP": ["NDX", "נאסד"], "SPX BPS": ["SPX", "ספרד"],
         "SPCX": ["SPCX", "SpaceX", "ספייס"], "IREN": ["IREN"], "RKLB": ["RKLB", "רוקט"]}
import re
def near(und, strike, others, t, used):
    names = alias.get(und, [und])
    out = []
    for pt, text, pid, topic in posts:
        if pid in used or abs((pt - t).total_seconds()) > 900: continue
        if not any(n.lower() in topic.lower() for n in names): continue
        nums = set(re.findall(r"\d+(?:\.\d+)?", topic))
        # Skip a post about another strike of the same underlying.
        if strike not in nums and nums & others: continue
        out.append((pt, text, pid))
    return out
groups = collections.defaultdict(list)
for i, f in enumerate(fills): f["_i"] = i; groups[key(f)].append(f)
actions, trades_out = [], []
for k, fs in groups.items():
    fs.sort(key=lambda f: (ts(f), f["_i"]))
    # Merge bursts
    bursts = []
    for f in fs:
        b = bursts[-1] if bursts else None
        if b and b[-1]["side"] == f["side"] and f["time_et"] and b[-1]["time_et"] and (ts(f) - ts(b[-1])).total_seconds() <= 45 and f["date"] == b[-1]["date"]:
            b.append(f)
        elif b and b[-1]["side"] == f["side"] and not f["time_et"] and not b[-1]["time_et"] and f["date"] == b[-1]["date"]:
            b.append(f)
        else:
            bursts.append([f])
    # Signed position: shares can be shorted (hedges); options are long only.
    pos, cost, realized, m = 0, 0.0, 0.0, mult(k[1], k[4])
    pre = fs[0]["side"] == "S" and k[4] != "S"  # option sold before any buy: opened before 2026
    if pre: pos = None
    n = 0
    trade_id = f"{fs[0]['date']}-{k[1].split()[0]}-{k[3]}{k[4]}"
    for b in bursts:
        side = b[0]["side"]; q = sum(int(f["qty"]) for f in b); px = sum(int(f["qty"]) * float(f["fill_price"]) for f in b) / q
        before = pos
        if pos is None:
            kind, pnl = "exit (entry not shown)", ""
        else:
            sq = q if side == "B" else -q
            if before == 0 or (before > 0) == (sq > 0):
                pos = before + sq; cost += sq * px
                kind = ("open" if not n else "re-enter") if before == 0 else "add"
                if k[4] == "S" and side == "S": kind = ("short" if before == 0 else "add short")
                pnl = ""
            else:
                avg = cost / before
                r = (px - avg) * min(q, abs(before)) * m * (1 if before > 0 else -1)
                realized += r; cost -= avg * (-sq); pos = before + sq
                kind = "close" if pos == 0 else "trim"; pnl = round(r)
        n += 1
        t = ts(b[0])
        others = {o[3] for o in groups if o[1] == k[1] and o[3] != k[3]}
        talk = near(k[1], k[3], others, t, set()) if b[0]["time_et"] else []
        t_end = ts(b[-1])
        actions.append(dict(trade=trade_id, account=k[0], contract=f"{k[1]} {k[2]} {k[3]}{k[4]}", date=b[0]["date"],
            time_from=b[0]["time_et"], time_to=b[-1]["time_et"], action=kind, side=side, qty=q, avg_price=round(px, 4),
            fills=len(b), position_after="" if pos is None else pos,
            avg_cost_after=round(cost / pos, 4) if pos else "", realized_step=pnl,
            realized_total=round(realized) if pos == 0 else "",
            _talk=talk, _span=(t, t_end), _key=k))
# Options still held after expiry with no sale shown expired worthless (assumed; a sale on a
# day without a posted Order Manager would be missing). Futures-option lists from IBKR are partial: left open.
for k, fs in groups.items():
    tr = [a for a in actions if a["_key"] == k]
    last = tr[-1]
    if k[4] in "CP" and k[0] != "ibkr" and last["position_after"] not in ("", 0) and k[2] < LAST_DAY:
        q = int(last["position_after"]); avg = float(last["avg_cost_after"]); m = mult(k[1], k[4])
        r = -avg * q * m; tot = sum(int(a["realized_step"]) for a in tr if a["realized_step"] != "") + r
        actions.append(dict(last, date=k[2], time_from="", time_to="", action="expired (assumed 0)", side="S", qty=q,
            avg_price=0, fills=0, position_after=0, avg_cost_after="", realized_step=round(r), realized_total=round(tot),
            _talk=[], _span=(dt.datetime.fromisoformat(k[2] + "T16:00:00"),) * 2))
# Exits whose entry is not shown take the realized P&L from that day's Portfolio line when there is one.
port = {}
for r in csv.DictReader(open(f"{d}/portfolio.csv")):
    if r["realized"]: port[(r["date"], r["account"], r["underlying"], r["expiry"], f"{float(r['strike']):g}", r["right"])] = float(r["realized"])
for k in groups:
    tr = [a for a in actions if a["_key"] == k]
    if all(a["action"] == "exit (entry not shown)" for a in tr):
        days = sorted({a["date"] for a in tr}); tot = 0.0
        for day in days:
            v = port.get((day,) + k)
            if v is None: continue
            tot += v; [a for a in tr if a["date"] == day][-1]["realized_step"] = round(v)
        if any(a["realized_step"] != "" for a in tr): tr[-1]["realized_total"] = round(tot)
for a in actions: a.pop("_key", None)
# Each post goes to the action nearest in time (distance to the action's time span).
# He posts right after acting, so a post belongs to the latest action that started before it;
# an action that starts after the post is a fallback only.
def dist(a, pt):
    lo, hi = a["_span"]
    return (pt - lo).total_seconds() if pt >= lo else 10_000 + (lo - pt).total_seconds()
best = {}
for i, a in enumerate(actions):
    for x in a["_talk"]:
        if x[2] not in best or dist(a, x[0]) < best[x[2]][0]: best[x[2]] = (dist(a, x[0]), i)
for i, a in enumerate(actions):
    mine = sorted((x for x in a.pop("_talk") if best[x[2]][1] == i), key=lambda x: x[0])
    a.pop("_span")
    a["his_post"] = " | ".join(f"[{x[0]:%H:%M}] {x[1]}" for x in mine)
    a["post_ids"] = " ".join(x[2] for x in mine)
actions.sort(key=lambda a: (a["date"], a["time_from"] or "99"))
w = csv.DictWriter(open(f"{d}/actions.csv", "w"), fieldnames=list(actions[0])); w.writeheader(); w.writerows(actions)
# Readable timeline grouped by trade
by = collections.defaultdict(list)
for a in actions: by[a["trade"]].append(a)
order = sorted(by, key=lambda t: (by[t][0]["date"], by[t][0]["time_from"] or "99"))
md = []
for t in order:
    a0 = by[t][0]
    md.append(f"## {a0['contract']} ({a0['account']})")
    for a in by[t]:
        tm = f"{a['date'][5:]} {a['time_from'][:5]}" + (f"–{a['time_to'][:5]}" if a['time_to'][:5] != a['time_from'][:5] else "")
        r = f" · step P&L {a['realized_step']:+,}" if a["realized_step"] != "" else ""
        p = f" · pos {a['position_after']}" + (f" @ avg {a['avg_cost_after']}" if a["avg_cost_after"] else "") if a["position_after"] != "" else ""
        md.append(f"- {tm} **{a['action'].upper()}** {'buy' if a['side']=='B' else 'sell'} {a['qty']} @ {a['avg_price']} ({a['fills']} fills){p}{r}")
        if a["his_post"]: md.append(f"  - he wrote: {a['his_post']}")
    last = by[t][-1]
    md.append(f"- **Result:** {last['realized_total']:+,} $" if last["realized_total"] != "" else "- **Result:** not closed in the data")
    md.append("")
open(f"{d}/timeline.md", "w").write("\n".join(md))
c = collections.Counter(a["action"] for a in actions); print(len(actions), "actions", dict(c), len(order), "trades")
print(sum(1 for a in actions if a["his_post"]), "actions with a matching post")
