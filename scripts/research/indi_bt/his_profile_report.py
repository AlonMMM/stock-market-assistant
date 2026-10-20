"""Tables from profile_rows.csv: his entries vs the bot's vs random moments, his winners vs losers, clusters."""
import csv, statistics as st, sys
import numpy as np
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

R = list(csv.DictReader(open("data/local/x/bt/profile_rows.csv")))
num = lambda x: float(x) if x not in ("", "None", None) else None
for r in R:
    for k, v in list(r.items()):
        if k not in ("set", "date", "sym", "right", "group"): r[k] = num(v)
F = ["tod", "gap", "mv_open", "ex_open", "mv5", "mv15", "mv60", "ex15", "spy_open", "spy15", "range_pos", "brk60", "dist60",
     "day_ext", "prev_out", "vwap_side", "vwap_dist", "rvol_day", "rvol15", "rvol5", "squeeze", "t", "since_ext", "prev_day", "ret5d", "fwd_close"]
FLAG = {"brk60", "day_ext", "prev_out", "vwap_side"}
def summ(rows, k):
    v = [r[k] for r in rows if r[k] is not None]
    if not v: return ""
    return f"{100*st.fmean(v):.0f}%" if k in FLAG else f"{st.median(v):.2f}"
his = [r for r in R if r["set"] == "his"]; bot = [r for r in R if r["set"] == "bot"]; rnd = [r for r in R if r["set"] == "random"]
hp = sorted([r for r in his if r["pnl"] is not None], key=lambda r: r["pnl"])
win = hp[-int(len(hp) * .1):]; lose = hp[:int(len(hp) * .5)]
caught = [r for r in his if r["group"] == "caught"]
print(f"| Feature | His ({len(his)}) | His top 10% ({len(win)}) | His bottom half | His caught by bot ({len(caught)}) | Bot ({len(bot)}) | Random ({len(rnd)}) |\n|---|---|---|---|---|---|---|")
for k in F:
    print(f"| {k} | {summ(his,k)} | {summ(win,k)} | {summ(lose,k)} | {summ(caught,k)} | {summ(bot,k)} | {summ(rnd,k)} |")
# time of day buckets
B_ = [(0, 10, "9:30-9:40"), (10, 30, "9:40-10:00"), (30, 60, "10:00-10:30"), (60, 120, "10:30-11:30"), (120, 240, "11:30-13:30"), (240, 375, "13:30-15:45"), (375, 390, "after 15:45")]
print("\n| Time | His entries | His P&L your stop | His real P&L | Bot entries | Bot P&L |\n|---|---|---|---|---|---|")
for a, b, lab in B_:
    h = [r for r in his if a <= r["tod"] < b]; bb = [r for r in bot if a <= r["tod"] < b]
    print(f"| {lab} | {len(h)} | {sum(r['pnl'] or 0 for r in h)/1e3:+,.0f}K | {sum(r['real'] or 0 for r in h)/1e6:+,.2f}M | {len(bb)} | {sum(r['pnl'] for r in bb)/1e3:+,.0f}K |")
# clusters of his entries
C = ["tod", "gap", "mv_open", "ex_open", "mv15", "mv60", "spy_open", "range_pos", "dist60", "rvol_day", "rvol5", "t", "prev_day", "ret5d", "vwap_dist", "squeeze"]
H = [r for r in his if all(r[k] is not None for k in C)]
X = np.array([[r[k] for k in C] for r in H]); X = np.clip(X, np.percentile(X, 2, axis=0), np.percentile(X, 98, axis=0))
Z = StandardScaler().fit_transform(X)
for K in (6,):
    lab = KMeans(n_clusters=K, n_init=20, random_state=3).fit_predict(Z)
    print(f"\n### {K} clusters of his entries ({len(H)})")
    print("| Cluster | n | tod | gap | mv_open | ex_open | mv15 | mv60 | spy_open | range_pos | rvol_day | rvol5 | t | prev_day | ret5d | P&L your stop | per trade | w/o best 3 | His real | caught by bot | years + (stop) |\n|" + "---|" * 21)
    for c in range(K):
        g = [r for r, l in zip(H, lab) if l == c]
        p = sorted(r["pnl"] for r in g if r["pnl"] is not None)
        yrs = "".join("+" if sum(r["pnl"] or 0 for r in g if r["date"][:4] == y) > 0 else "-" for y in ("2024", "2025", "2026"))
        med = lambda k: f"{st.median(r[k] for r in g):.2f}"
        print(f"| {c} | {len(g)} | {st.median(r['tod'] for r in g):.0f} | {med('gap')} | {med('mv_open')} | {med('ex_open')} | {med('mv15')} | {med('mv60')} | {med('spy_open')} | {med('range_pos')} | {med('rvol_day')} | {med('rvol5')} | {med('t')} | {med('prev_day')} | {med('ret5d')} | {sum(p)/1e3:+,.0f}K | {st.fmean(p):+,.0f} | {sum(p[:-3])/1e3:+,.0f}K | {sum(r['real'] or 0 for r in g)/1e6:+,.2f}M | {sum(r['group']=='caught' for r in g)} | {yrs} |")
    with open("data/local/x/bt/profile_clusters.csv", "w") as f:
        w = csv.writer(f); w.writerow(["date", "sym", "right", "minute", "cluster", "pnl", "real"])
        for r, l in zip(H, lab): w.writerow([r["date"], r["sym"], r["right"], int(r["tod"]), l, r["pnl"], r["real"]])
