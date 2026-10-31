"""Minute stock bars only where the monthly hot list needs them: a name's months on the list and the month before."""
import json, os, sys, datetime as dt, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BT_VARIANT", "v2")
import store
L = json.load(open(os.environ["HOT_FILE"])); need = set(json.load(open(os.environ["SYMS_FILE"])))
by = collections.defaultdict(set)
for k, v in L.items():
    m = dt.date.fromisoformat(k + "-01"); prev = (m - dt.timedelta(days=1)).replace(day=1)
    for s in v:
        if s in need: by[m].add(s); by[prev].add(s)
W, K = int(os.environ.get("FW", 1)), int(os.environ.get("FK", 0))
for i, m in enumerate(sorted(by)):
    if i % W != K: continue
    nxt = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    U = sorted(by[m])
    for j in range(0, len(U), 8): store.fetch_bars("stocks", U[j:j + 8], m.isoformat(), (nxt - dt.timedelta(days=1)).isoformat())
    print(f"month {m} done, {len(U)} names", flush=True)
print("FETCH DONE", flush=True)
