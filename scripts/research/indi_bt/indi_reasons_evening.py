import bisect, datetime as dt, glob, json, sys
from zoneinfo import ZoneInfo
NY = ZoneInfo("America/New_York"); X = "data/local/x"; S = sys.argv[1]
posts = {}
for f in glob.glob(f"{X}/ultrawavetrader-20[0-9][0-9]/threads.json"):
    for th in json.load(open(f)):
        for p in th["posts"]:
            t = dt.datetime.fromisoformat(p["time"].replace("Z", "+00:00")).astimezone(NY)
            posts[p["id"]] = (t.strftime("%Y-%m-%d %H:%M"), p["text"])
P = sorted(posts.values()); PT = [p[0] for p in P]
B = [t for i in range(1, 9) for t in json.load(open(f"{S}/in/batch{i}.json"))]
out = []
for t in B:
    d0 = t["entry_day"]
    ev = [dict(t=p[0], text=p[1][:1500]) for p in P[bisect.bisect_left(PT, f"{d0} 16:15"): bisect.bisect_right(PT, f"{d0} 20:00")] if not p[1].startswith("@")]
    out.append(dict(id=t["id"], sym=t["sym"], contract=t["contract"], entry_day=d0, evening_posts=ev))
by = {}
for t in out: by.setdefault(t["entry_day"], []).append(t)
days = sorted(by); n = 4; size = -(-len(days) // n)
for i in range(n):
    chunk = [t for d in days[i*size:(i+1)*size] for t in by[d]]
    json.dump(chunk, open(f"{S}/in2/eve{i+1}.json", "w"), ensure_ascii=False, indent=0)
    print(f"eve{i+1}", len(chunk), sum(bool(t["evening_posts"]) for t in chunk), "with evening posts")
