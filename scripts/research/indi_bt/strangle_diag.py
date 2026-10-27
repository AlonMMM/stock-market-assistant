import json, multiprocessing as mp, os, statistics as st, sys
sys.path.insert(0, "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
import strangle_real as S
MID = os.environ.get("MID") == "1"
if MID:
    q0 = S.quote
    def qm(c, d, m):
        q = q0(c, d, m)
        return ((q[0] + q[1]) / 2, (q[0] + q[1]) / 2) if q else None
    S.quote = qm
    S.buy_at = lambda c, d, m, q: q[0]
S.COMM = 0.0 if MID else S.COMM
if os.environ.get("EARLY") == "1":
    sims0 = S.sims
    def early(e):
        sb = {b[0]: b for b in S.day(e["sym"], e["date"])}
        if e["m"] - 1 not in sb: return []
        return sims0(dict(e, m=e["m"] - 1, stock0=sb[e["m"] - 1][4]))
    S.sims = early
KEYS = [(0.35, 0.25, 60, 1, "opt30"), (0.35, 0.25, 60, 0, "opt30"), (0.5, 0.25, 5, 0, "stk75"), (0.35, 0.25, 10, 0, "stk75"), (0.25, 0.25, 10, 0, "stk75")]
if __name__ == "__main__":
    ev = json.load(open(S.EV))
    if os.environ.get("STR_TOP"):
        top = set(json.load(open(os.path.join(os.path.dirname(S.__file__), "strangle_top40.json")))[:int(os.environ["STR_TOP"])])
        ev = [e for e in ev if e["sym"] in top]
    with mp.Pool(8) as pool: res = pool.map(S.sims, sorted(ev, key=lambda e: e["date"]), chunksize=16)
    by = {}
    for rs in res:
        for r in rs:
            if r[:5] in KEYS: by.setdefault(r[:5], []).append(r)
    for k in KEYS:
        v = by.get(k, [])
        rets = [r[10] / r[9] - 1 for r in v]
        print(k, "mid" if MID else "real", "early" if os.environ.get("EARLY") == "1" else "", len(v), f"avg {100*st.mean(rets):+.1f}%  median {100*st.median(rets):+.1f}%  win {100*sum(x>0 for x in rets)/len(rets):.0f}%  pair spread {100*st.median(r[11] for r in v):.0f}%")
