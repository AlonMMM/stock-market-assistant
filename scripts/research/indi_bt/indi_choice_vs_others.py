"""His choice vs the others (the user 2026-11-07: "I do not want to seperaeate loosers with winners. I want to seperate
his COICE with otheres"). Each of his overnight nights (indi_nights.json) vs every other name of the top 50 the same
night and side (nightly_feat.csv.gz, 15:57) and vs the look-alikes (the night's 10 strongest days by rs_day).
Per measure: his percentile; tune / check by split.half."""
import csv, gzip, json, math, sqlite3, statistics as st, sys, collections
sys.path.insert(0, "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
from split import half
A = "/Users/alonmo/Desktop/Personal/stock-market-assistant/data/local/x/bt/"
N = json.load(open(A + "indi_nights.json"))
want = {(n["date"], n["right"]) for n in N}
rows = collections.defaultdict(list)
F = ["rs_day","gap_z","rs_3d","t","consist","rs_down","rvol","rvol_late","updown","dollar","burst","burst_size","lh_run","depth","lh_range","pos","gap_hold","vwap_ext","burst_age"]
with gzip.open(A + "nightly_feat.csv.gz", "rt") as fh:
    for x in csv.DictReader(fh):
        if (x["date"], x["side"]) in want and x["earn"] == "0":
            r = {k: (float(x[k]) if x[k] not in ("", None) else None) for k in F + ["on", "z_on"]}
            r["sym"] = x["sym"]; rows[(x["date"], x["side"])].append(r)
db = sqlite3.connect(A + "daily_all.sqlite"); cache = {}
def daily(s):
    if s not in cache: cache[s] = db.execute("select date,o,h,l,c,v from day where symbol=? order by date", (s,)).fetchall()
    return cache[s]
spy = {r[0]: r[4] for r in daily("SPY")}
def dfeat(sym, date, side):
    D = [r for r in daily(sym) if r[0] <= date]
    if len(D) < 260 or D[-1][0] != date: return {}
    s = 1 if side == "C" else -1
    C = [r[4] for r in D]; dd = [r[0] for r in D]
    if any(x not in spy for x in dd[-62:]): return {}
    S = [spy[x] for x in dd]
    rs = [C[i]/C[i-1]-1 for i in range(len(C)-60, len(C))]; rm = [S[i]/S[i-1]-1 for i in range(len(S)-60, len(S))]
    mm = st.mean(rm); b = sum((a-st.mean(rs))*(c-mm) for a, c in zip(rs, rm)) / (sum((c-mm)**2 for c in rm) or 1e-9)
    res = [a-b*c for a, c in zip(rs, rm)]; sd = st.pstdev(res) or 1e-9
    tr = [max(D[i][2], D[i-1][4]) - min(D[i][3], D[i-1][4]) for i in range(len(D)-15, len(D)-1)]; atr = st.mean(tr)
    o = {}
    for n in (5, 20, 60): o[f"rs{n}"] = s*((C[-2]/C[-2-n]-1) - b*(S[-2]/S[-2-n]-1)) / (sd*math.sqrt(n))   # up to yesterday
    P = D[:-1]
    hi52, lo52 = max(r[2] for r in P[-252:]), min(r[3] for r in P[-252:])
    o["to52"] = ((C[-1]-hi52) if s > 0 else (lo52-C[-1])) / atr          # today's close vs the 52-week extreme, ATR
    hi20, lo20 = max(r[2] for r in P[-20:]), min(r[3] for r in P[-20:])
    o["brk20"] = ((C[-1]-hi20) if s > 0 else (lo20-C[-1])) / atr          # today's close past the 20-day extreme
    r10 = max(r[2] for r in P[-10:]) - min(r[3] for r in P[-10:]); r60 = max(r[2] for r in P[-60:]) - min(r[3] for r in P[-60:])
    o["tight10"] = -r10 / r60 if r60 else None                            # a tight base before today (higher = tighter)
    ma50 = st.mean(C[-51:-1]); o["ma50"] = s*(C[-1]/ma50-1)*100/(atr/C[-1]*100)
    o["yday"] = s*(C[-2]/C[-3]-1 - b*(S[-2]/S[-3]-1)) / sd                # yesterday his way vs beta*SPY (day 2)
    o["atr_pct"] = atr / C[-1] * 100
    o["price"] = C[-1]
    return o
seen = collections.defaultdict(list)
for n in sorted(N, key=lambda n: n["date"]): seen[n["sym"]].append(n["date"])
ALL = None; recs = []
for n in N:
    k = (n["date"], n["right"]); cand = rows.get(k, [])
    if not any(c["sym"] == n["sym"] for c in cand): continue
    for c in cand:
        c.update(dfeat(c["sym"], n["date"], n["right"]))
        prev = [d for d in seen[c["sym"]] if d < n["date"]]
        c["his_before"] = len(prev)          # times he held it overnight before (any side)
    recs.append((n, cand))
M = F + ["rs5","rs20","rs60","to52","brk20","tight10","ma50","yday","atr_pct","price","his_before"]
print(len(recs), "of", len(N), "nights with his stock in the top 50 that night (no earnings)")
def pct(v, others):
    o = [x for x in others if x is not None]
    if v is None or not o: return None
    return 100 * (sum(x < v for x in o) + 0.5 * sum(x == v for x in o)) / len(o)
out = []
for m in M:
    line = [m]
    for scope in ("all", "look10"):
        for p in ("tune", "check"):
            ps = []
            for n, cand in recs:
                if half(n["date"]) != p: continue
                pool = cand
                if scope == "look10": pool = sorted([c for c in cand if c["rs_day"] is not None], key=lambda c: -c["rs_day"])[:10]
                me = next((c for c in pool if c["sym"] == n["sym"]), None)
                if not me: continue
                q = pct(me.get(m), [c.get(m) for c in pool if c["sym"] != n["sym"]])
                if q is not None: ps.append(q)
            line.append(f"{st.median(ps):5.0f} ({len(ps)})" if ps else "  -  ")
    out.append(line)
print(f"{'measure':12s} | all names: tune | check || look-alikes (night's top 10 by today's strength): tune | check")
for l in out: print(f"{l[0]:12s} | {l[1]:>10s} | {l[2]:>10s} || {l[3]:>10s} | {l[4]:>10s}")
print("\nDid the choice beat the look-alikes overnight? (the stock 15:57 -> 09:45 his way, z)")
for p in ("tune", "check"):
    me_z, oth_z, beat = [], [], []
    for n, cand in recs:
        if half(n["date"]) != p: continue
        pool = sorted([c for c in cand if c["rs_day"] is not None], key=lambda c: -c["rs_day"])[:10]
        me = next((c for c in pool if c["sym"] == n["sym"]), None)
        if not me or me["z_on"] is None: continue
        o = [c["z_on"] for c in pool if c["sym"] != n["sym"] and c["z_on"] is not None]
        me_z.append(me["z_on"]); oth_z.append(st.median(o)); beat.append(pct(me["z_on"], o))
    print(f"{p}: {len(me_z)} nights, his z median {st.median(me_z):+.2f} vs the others' {st.median(oth_z):+.2f}, his percentile median {st.median(beat):.0f}, up his way {100*sum(z>0 for z in me_z)/len(me_z):.0f}%")
json.dump([(n, cand) for n, cand in recs], open(sys.argv[1], "w"))
