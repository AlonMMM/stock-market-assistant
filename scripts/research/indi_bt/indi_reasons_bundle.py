import bisect, collections, csv, datetime as dt, glob, json, re, sys
from zoneinfo import ZoneInfo
NY = ZoneInfo("America/New_York")
X = "data/local/x"; OUT = sys.argv[1]
A = []
for f in sorted(glob.glob(f"{X}/ultrawavetrader-20[0-9][0-9]/actions.csv")):
    A += [a for a in csv.DictReader(open(f)) if a["account"] == "silexx"]
byt = collections.defaultdict(list)
for a in A: byt[a["trade"]].append(a)
posts = {}
for f in glob.glob(f"{X}/ultrawavetrader-20[0-9][0-9]/threads.json"):
    for th in json.load(open(f)):
        for p in th["posts"]:
            t = dt.datetime.fromisoformat(p["time"].replace("Z", "+00:00")).astimezone(NY)
            posts[p["id"]] = (t.strftime("%Y-%m-%d %H:%M"), p["text"], th["conversation"])
P = sorted(posts.values()); PT = [p[0] for p in P]
held = []
for k, v in byt.items():
    v.sort(key=lambda a: (a["date"], a["time_from"] or "99"))
    if len({a["date"] for a in v}) > 1: held.append((k, v))
held.sort(key=lambda kv: (kv[1][0]["date"], kv[1][0]["time_from"] or ""))
B = []
for k, v in held:
    sym = v[0]["contract"].split()[0]; d0 = v[0]["date"]; last = v[-1]["date"]
    rx = re.compile(rf"(?<![A-Za-z])\$?{re.escape(sym)}(?![A-Za-z])", re.I)
    ent = [dict(date=a["date"], time=a["time_from"], action=a["action"], side=a["side"], qty=a["qty"], px=a["avg_price"],
                post=a["his_post"]) for a in v if a["date"] == d0]
    before, after = [], []
    for p in P[bisect.bisect_left(PT, f"{d0} 08:00"): bisect.bisect_right(PT, f"{last} 16:30")]:
        if p[1].startswith("@"): continue
        about = bool(rx.search(p[1]))
        dayw = p[0] <= f"{d0} 16:15"
        market = f"{d0} 14:00" <= p[0] <= f"{d0} 16:15"
        if dayw and (about or market): before.append(dict(t=p[0], about=about, text=p[1][:900]))
        elif not dayw and about: after.append(dict(t=p[0], text=p[1][:600]))
    B.append(dict(id=k, sym=sym, contract=v[0]["contract"], entry_day=d0, last_day=last, entry_day_fills=ent,
                  posts_until_close=before[-40:], later_posts_about_it=after[:12]))
print(len(B), "overnight trades")
n = 8; size = -(-len(B) // n)
for i in range(n):
    json.dump(B[i*size:(i+1)*size], open(f"{OUT}/batch{i+1}.json", "w"), ensure_ascii=False, indent=0)
    print(f"batch{i+1}", len(B[i*size:(i+1)*size]), B[i*size]["entry_day"], "->", B[min(len(B), (i+1)*size)-1]["entry_day"])
