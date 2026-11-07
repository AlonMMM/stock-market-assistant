"""His main idea in measures (the user 2026-11-07, after his reasons were read: "Yes suggest me"). He picks a stock
that won't do what its driver says ("refuses to correct", "showing independence", "decoupling from Nvidia") and that
"held at the high". Per night / side / name of the top 50 (recs.json, no earnings), at 15:57, signed his way:
  drv      the stock's driver = the most correlated of a fixed set (QQQ IWM SMH NVDA bitcoin GLD SLV USO XBI IGV KWEB
           ARKK XLF XLE TLT TSLA, never itself), daily returns, 120 days before; bitcoin = IBIT, BITO before 2024-02
  drv_day  today to 15:57 vs beta x driver, in daily residual sd (rs_day vs its driver, not SPY)
  drv_down 5-min cuts where the driver went against his side: the stock's residual sum / (sd of cuts x sqrt n)
  held120  the giveback from the day's extreme in the last 2 hours, in ATR (lower = held; signed so high = held)
  late_hi  15:57 within 0.15 ATR of the day's extreme after a 0.5 ATR+ pullback from it in the afternoon (0/1)
His calm picks (ATR < 3.6%) vs the calm names he passed on, tune / check; then on all calm names whether the top
fifth of each measure has more 2%+ nights his way."""
import json, math, sqlite3, statistics as st, sys, collections
sys.path.insert(0, "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
from split import half
S = "/private/tmp/claude-501/-Users-alonmo-Desktop-Personal-stock-market-assistant/6fb99457-9696-4e71-87a7-c3ad635440fb/scratchpad"
A = "/Users/alonmo/Desktop/Personal/stock-market-assistant/data/local/x/bt/"
R = json.load(open(S + "/choice/recs.json"))
mdb = sqlite3.connect(A + "market.sqlite"); ddb = sqlite3.connect(A + "daily_all.sqlite")
DRV = ["QQQ", "IWM", "SMH", "NVDA", "BTC", "GLD", "SLV", "USO", "XBI", "IGV", "KWEB", "ARKK", "XLF", "XLE", "TLT", "TSLA"]
dc = {}
def daily(s):
    if s not in dc: dc[s] = {r[0]: r[1:] for r in ddb.execute("select date,h,l,c from day where symbol=?", (s,))}
    return dc[s]
def btc(date): return "IBIT" if date >= "2024-02-12" else "BITO"
def real(d, date): return btc(date) if d == "BTC" else d
mc = {}
def bars(s, date):
    k = (s, date)
    if k not in mc:
        r = mdb.execute("select bars from bars where symbol=? and date=?", k).fetchone()
        by = {b[0]: b for b in json.loads(r[0])} if r else {}
        c, h, l, last = [], [], [], None
        for m in range(390):
            b = by.get(m); last = b or last
            c.append(last[4] if last else None); h.append(b[2] if b else c[-1]); l.append(b[3] if b else c[-1])
        mc[k] = (c, h, l) if by else None
    return mc[k]
CAL = sorted(daily("SPY"))
def rets(s, ds):
    D = daily(s)
    if any(d not in D for d in ds): return None
    return [D[ds[i]][2] / D[ds[i - 1]][2] - 1 for i in range(1, len(ds))]
def fit(x, y):
    mx, my = st.mean(x), st.mean(y)
    vx = sum((a - mx) ** 2 for a in x); vy = sum((b - my) ** 2 for b in y)
    if not vx or not vy: return None
    if st.pstdev(y) == 0: return None
    cov = sum((a - mx) * (b - my) for a, b in zip(x, y))
    b = cov / vx; res = [q - b * p for p, q in zip(x, y)]
    return cov / math.sqrt(vx * vy), b, st.pstdev(res)
def mx(v): return max(x for x in v if x is not None)
def mn(v): return min(x for x in v if x is not None)
def meas(sym, date, side, atr_pct):
    i = CAL.index(date); ds = CAL[i - 121:i]
    y = rets(sym, ds)
    if not y: return None
    best = None
    for d in DRV:
        if d == sym: continue
        x = rets(real(d, date), ds)
        if not x: continue
        f = fit(x, y)
        if f and (best is None or f[0] > best[1][0]): best = (d, f)
    if not best: return None
    d, (corr, b, sd) = best; dr = real(d, date)
    if not sd: return None
    s = 1 if side == "C" else -1
    B, D = bars(sym, date), bars(dr, date)
    if not B or not D or B[0][387] is None or D[0][387] is None: return None
    pc, pd = daily(sym)[CAL[i - 1]][2], daily(dr)[CAL[i - 1]][2]
    o = dict(drv=d, corr=round(corr, 2))
    o["drv_day"] = s * ((B[0][387] / pc - 1) - b * (D[0][387] / pd - 1)) / sd
    cuts = [(B[0][m] / B[0][m - 5] - 1 - b * (D[0][m] / D[0][m - 5] - 1), D[0][m] / D[0][m - 5] - 1) for m in range(5, 388, 5)
            if B[0][m] and B[0][m - 5] and D[0][m] and D[0][m - 5]]
    sc = st.pstdev([r for r, _ in cuts]) or 1e-9
    adv = [s * r for r, dm in cuts if s * dm < 0]
    o["drv_down"] = sum(adv) / (sc * math.sqrt(len(adv))) if adv else 0.0
    atr = atr_pct / 100 * B[0][387]
    c, h, l = B
    if s > 0:
        ext = max(x for x in h[:388] if x); give = ext - min(x for x in l[267:388] if x)
        hi_at = max(range(388), key=lambda m: h[m] or 0); near = ext - c[387]
        dip = ext - min(x for x in l[max(hi_at, 210):388] if x) if hi_at < 380 else 0
        late = mx(h[358:388]) >= ext - 0.15 * atr and mn(l[210:358]) <= mx(h[:358]) - 0.5 * atr
    else:
        ext = min(x for x in l[:388] if x); give = max(x for x in h[267:388] if x) - ext; near = c[387] - ext
        late = mn(l[358:388]) <= ext + 0.15 * atr and mx(h[210:358]) >= mn(l[:358]) + 0.5 * atr
    o["held120"] = -give / atr
    o["late_hi"] = 1.0 if late and near <= 0.15 * atr else 0.0
    return o
M = ["drv_day", "drv_down", "held120", "late_hi", "rs_day", "rs_down"]
pct = {h: collections.defaultdict(list) for h in ("tune", "check")}
pool = []; drvs = collections.Counter(); nn = collections.Counter()
for n, cand in R:
    calm = [c for c in cand if c.get("atr_pct") and c["atr_pct"] < 3.6 and c.get("on") is not None]
    mine = [c for c in calm if c["sym"] == n["sym"]]
    for c in calm:
        x = meas(c["sym"], n["date"], n["right"], c["atr_pct"])
        if x: c.update(x); c["his"] = c["sym"] == n["sym"]; c["date"] = n["date"]; pool.append(c)
    if not mine or "drv_day" not in mine[0]: continue
    me = mine[0]; h = half(n["date"]); nn[h] += 1; drvs[me["drv"]] += 1
    others = [c for c in calm if c["sym"] != n["sym"] and "drv_day" in c]
    if len(others) < 3: continue
    for k in M:
        if me.get(k) is None: continue
        v = [c[k] for c in others if c.get(k) is not None]
        pct[h][k].append(100 * (sum(a < me[k] for a in v) + 0.5 * sum(a == me[k] for a in v)) / len(v))
print("his calm picks with measures:", dict(nn), " their drivers:", drvs.most_common())
print("\nHis calm pick's percentile among the calm names he passed on (50 = no difference)")
print(f"{'measure':10} {'tune':>6} {'n':>4} {'check':>6} {'n':>4}")
for k in M:
    print(f"{k:10} " + " ".join(f"{st.mean(pct[h][k]):6.0f} {len(pct[h][k]):4d}" for h in ("tune", "check")))
print("\nAll calm names (his picks included): share of nights with the stock 2%+ his way / 2%+ against, by fifth of the measure")
for k in M:
    for h in ("tune", "check"):
        P = [c for c in pool if half(c["date"]) == h and c.get(k) is not None]
        P.sort(key=lambda c: c[k]); q = len(P) // 5
        if k == "late_hi":
            G = [("no", [c for c in P if c[k] == 0]), ("yes", [c for c in P if c[k] == 1])]
        else:
            G = [(f"q{j+1}", P[j * q:(j + 1) * q if j < 4 else len(P)]) for j in range(5)]
        cells = " | ".join(f"{g} {100*sum(c['on'] >= .02 for c in X)/len(X):4.1f}/{100*sum(c['on'] <= -.02 for c in X)/len(X):4.1f} n{len(X)}" for g, X in G if X)
        print(f"{k:9} {h:5}  {cells}")
json.dump([{k: c.get(k) for k in ["date", "sym", "his", "drv", "corr", "on"] + M} for c in pool], open(S + "/driver/pool.json", "w"))
