"""V2 study: support and resistance (the user's idea, 2026-10-23). No rule change; three questions:

  1  Entry: does the room to the next resistance at the signal tell the champion's good trades from the bad?
  2  After the entry: when the stock reaches that resistance, does a break and a failed break end differently, and
     what would selling at the failed break have done (vs the champion's own result)?
  3  Indi: are his exits (and entries) nearer a level than a random minute of the same stock-day? and our bot's?

Levels, fixed before running, all known at the minute they are used:
  yesterday's high / low, the 5 sessions before's high / low, the first 15 minutes' high / low (from 09:45), the day's
  high / low so far (before this minute's bar).
Distances are in the stock's own unit S30: the spread (stdev) of its 1-minute returns over the 5 sessions before,
x sqrt(30), x the price: a typical 30-minute move. "At a level" = within 0.25 S30.
Break: a close >= 0.25 S30 beyond the level. Failed break: within 0.25 S30 of it, then a close >= 0.5 S30 back
from it without a break in between (within 30 minutes of the first touch).
Champion trades (t >= 1.8, news filter, delta 0.15, your stop + overnight hold); entry day only, until 15:50.

  python3 levels.py      (from the repo root)
"""
import collections, csv, glob, math, multiprocessing as mp, os, random, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import day, calendar
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
CAL = calendar()
IDX = {d: i for i, d in enumerate(CAL)}
X0 = {**sim.X, **H, **NIGHT}
NEAR, BREAK, BACK, WAIT = 0.25, 0.25, 0.5, 30
EOD = 380


def ctx(sym, date):
    """-> dict(c, h, l, s30, prev_hi, prev_lo, p5_hi, p5_lo) or None."""
    i = IDX.get(date)
    if i is None or i < 6: return None
    bars = day(sym, date)
    if len(bars) < 300: return None
    c, h, l = [None] * 390, [None] * 390, [None] * 390
    for b in bars:
        if 0 <= b[0] < 390: c[b[0]], h[b[0]], l[b[0]] = b[4], b[2], b[3]
    rets, p5h, p5l = [], [], []
    for k in range(i - 5, i):
        pb = day(sym, CAL[k])
        if not pb: return None
        p5h.append(max(b[2] for b in pb)); p5l.append(min(b[3] for b in pb))
        rets += [math.log(pb[j][4] / pb[j - 1][4]) for j in range(1, len(pb)) if pb[j - 1][4] > 0 and pb[j][4] > 0]
    if len(rets) < 500: return None
    pb = day(sym, CAL[i - 1])
    return dict(c=c, h=h, l=l, sd=st.pstdev(rets) * math.sqrt(30), prev_hi=max(b[2] for b in pb), prev_lo=min(b[3] for b in pb),
                p5_hi=max(p5h), p5_lo=min(p5l))


def levels_at(x, m):
    """Named levels known at minute m (the day's extremes before m's bar)."""
    L = {"yesterday high": x["prev_hi"], "yesterday low": x["prev_lo"], "5-day high": x["p5_hi"], "5-day low": x["p5_lo"]}
    hs = [v for v in x["h"][:m] if v]; ls = [v for v in x["l"][:m] if v]
    if hs: L["day high so far"], L["day low so far"] = max(hs), min(ls)
    if m >= 15 and any(x["h"][:15]):
        L["15-min high"] = max(v for v in x["h"][:15] if v); L["15-min low"] = min(v for v in x["l"][:15] if v)
    return L


def ahead(x, m, bet):
    """-> (name, level, distance in S30) of the nearest level ahead in the bet's direction, or None (open sky)."""
    p = x["c"][m]
    if p is None: return None
    best = None
    for n, v in levels_at(x, m).items():
        d = bet * (v - p) / (x["sd"] * p)
        if d > 0 and (best is None or d < best[2]): best = (n, v, d)
    return best


def nearest_any(x, m):
    """-> (name, |distance| in S30) of the nearest level either side at minute m."""
    p = x["c"][m]
    if p is None: return None
    return min(((n, abs(v - p) / (x["sd"] * p)) for n, v in levels_at(x, m).items()), key=lambda z: z[1])


def opt_close(sym, date, m):
    b = sim.last_bar(day(sym, date), m, 10)
    return b[4] if b else None


def study(t):
    bet = 1 if t["right"] == "C" else -1
    m0 = int(t["minute"])
    sim.X.clear(); sim.X.update(X0)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], t["contract"], t["expiry"], CAL)
    x = ctx(t["sym"], t["date"])
    if cost is None or x is None or x["c"][m0] is None: return None
    ret = sim.result(cost, steps)
    out = dict(key=(t["date"], t["sym"], t["minute"]), ret=ret, room=None, level=None, event=None, fwd=None, cf=None, exit_near=[])
    a = ahead(x, m0, bet)
    if a: out["level"], out["room"] = a[0], a[2]
    # the champion's same-day sale minutes, for question 3
    out["exit_near"] = [nearest_any(x, s[1]) for s in steps if s[2] == "sell" and s[0] == t["date"] and s[1] < 390 and x["c"][s[1]]]
    out["exit_near"] = [z[1] for z in out["exit_near"] if z]
    if not a: return out
    lv, sd0 = a[1], x["sd"] * x["c"][m0]
    last = max((s[1] for s in steps if s[2] == "sell" and s[0] == t["date"]), default=EOD)  # open until here on the entry day
    end = min(EOD, last if not any(s[2] == "carry" for s in steps) else EOD)
    touch = None
    for m in range(m0 + 1, end):
        p = x["c"][m]
        if p is None: continue
        d = bet * (lv - p) / sd0  # > 0: still under the level
        if d <= -BREAK: out["event"] = ("break", m); break
        if d <= NEAR and touch is None: touch = m
        if touch is not None and d >= BACK and m - touch <= WAIT: out["event"] = ("fail", m); break
        if touch is not None and m - touch > WAIT: out["event"] = ("stalled at it", m); break
    if out["event"] is None: out["event"] = ("never reached" if touch is None else "touched", None)
    m = out["event"][1]
    if m is not None:
        px = opt_close(t["contract"], t["date"], m); pe = opt_close(t["contract"], t["date"], EOD - 1)
        nxt = next((b for b in day(t["contract"], t["date"]) if b[0] > m), None)
        if px and pe: out["fwd"] = pe / px - 1
        if nxt:  # sell what is still held at the event (next bar's middle - 2%), keep the sales before it
            sold = sum(s[3] * s[4] for s in steps if s[2] == "sell" and (s[0], s[1]) <= (t["date"], m))
            rem = 1 - sum(s[3] for s in steps if s[2] == "sell" and (s[0], s[1]) <= (t["date"], m))
            out["cf"] = (sold + rem * sim.mid(nxt) * (1 - sim.SH)) / cost - 1
    return out


def his_events():
    """Indi's main-account entries and exits on his 40 stocks with a time: (kind, sym, date, minute)."""
    E = []
    for y in ("2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx" or not r["time_from"] or r["date"] < "2024-02-01": continue
            und = r["contract"].split(" ")[0]
            if und not in HIS40: continue
            hh, mm = map(int, r["time_from"][:5].split(":")); m = hh * 60 + mm - 570
            if not 1 <= m < 390: continue
            kind = "entry" if r["side"] == "B" and r["action"] in ("open",) else ("exit" if r["side"] == "S" else None)
            if kind: E.append((kind, und, r["date"], m))
    return E


def near_share(rows):
    """rows: [(stock-day ctx, minute)] -> share within NEAR of any level, of a non-intraday level, and the random base."""
    def lv(x, m, intraday):
        p = x["c"][m]
        if p is None: return None
        L = levels_at(x, m)
        if not intraday: L = {k: v for k, v in L.items() if "so far" not in k and "15-min" not in k}
        return min(abs(v - p) / (x["sd"] * p) for v in L.values())
    rnd = random.Random(7)
    a = b = ra = rb = n = 0
    for x, m in rows:
        d1, d2 = lv(x, m, True), lv(x, m, False)
        mr = rnd.randrange(10, 380); r1, r2 = lv(x, mr, True), lv(x, mr, False)
        if None in (d1, d2, r1, r2): continue
        n += 1; a += d1 <= NEAR; b += d2 <= NEAR; ra += r1 <= NEAR; rb += r2 <= NEAR
    return n, a / n, b / n, ra / n, rb / n


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = {r["key"]: r for r in pool.map(study, T, chunksize=10) if r}
    key = lambda t: (t["date"], t["sym"], t["minute"])
    lists = (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40))
    pt = lambda v: 1e4 * max(-1, v)
    for lname, lf in lists:
        L = [R[key(t)] for t in T if lf(t) and key(t) in R]
        print(f"\n## {lname}: {len(L)} trades\n\n### 1. Room to the next resistance at the signal (S30 = a typical 30-minute move)\n")
        print("| Room | Trades | Winners | Per trade at $10K | Sum | Median |\n|---|---|---|---|---|---|")
        for lab, f in (("< 0.25 (at it)", lambda r: r["room"] is not None and r["room"] < 0.25), ("0.25-0.5", lambda r: r["room"] is not None and 0.25 <= r["room"] < 0.5),
                       ("0.5-1", lambda r: r["room"] is not None and 0.5 <= r["room"] < 1), ("1-2", lambda r: r["room"] is not None and 1 <= r["room"] < 2),
                       ("2+", lambda r: r["room"] is not None and r["room"] >= 2), ("open sky (no level ahead)", lambda r: r["room"] is None)):
            g = [r for r in L if f(r)]
            if not g: continue
            print(f"| {lab} | {len(g)} | {100 * sum(r['ret'] > 0 for r in g) / len(g):.0f}% | {st.fmean(pt(r['ret']) for r in g):+,.0f} | {sum(pt(r['ret']) for r in g) / 1e3:+,.0f}K | {100 * st.median(r['ret'] for r in g):+.0f}% |")
        print("\n| Next level ahead | Trades | Per trade at $10K |\n|---|---|---|")
        for n, c in collections.Counter(r["level"] or "open sky" for r in L).most_common():
            g = [r for r in L if (r["level"] or "open sky") == n]
            print(f"| {n} | {c} | {st.fmean(pt(r['ret']) for r in g):+,.0f} |")
        print("\n### 2. What happened at that level (entry day, while held)\n")
        print("| At the level | Trades | Winners | Champion per trade at $10K | Option from then to 15:49, median | Sell all at that minute: per trade (change) |\n|---|---|---|---|---|---|")
        for ev in ("break", "fail", "stalled at it", "touched", "never reached"):
            g = [r for r in L if r["event"] and r["event"][0] == ev]
            if not g: continue
            fw = [r["fwd"] for r in g if r["fwd"] is not None]
            cf = [r for r in g if r["cf"] is not None]
            cft = f"{st.fmean(pt(r['cf']) for r in cf):+,.0f} ({st.fmean(pt(r['cf']) - pt(r['ret']) for r in cf):+,.0f})" if cf else "-"
            print(f"| {ev} | {len(g)} | {100 * sum(r['ret'] > 0 for r in g) / len(g):.0f}% | {st.fmean(pt(r['ret']) for r in g):+,.0f} | {(100 * st.median(fw)) if fw else float('nan'):+.0f}% | {cft} |")
        fails = sorted((r for r in L if r["event"] and r["event"][0] == "fail" and r["cf"] is not None), key=lambda r: pt(r["cf"]) - pt(r["ret"]))
        if fails:
            print("\nFailed break, selling there hurts most:", [(r["key"][1], r["key"][0], f"{100 * (r['cf'] - r['ret']):+.0f} pts") for r in fails[:4]])
            print("helps most:", [(r["key"][1], r["key"][0], f"{100 * (r['cf'] - r['ret']):+.0f} pts") for r in fails[-4:]])
            ch = [pt(r["cf"]) - pt(r["ret"]) for r in fails]
            print(f"helped {sum(c > 0 for c in ch)}, hurt {sum(c < 0 for c in ch)}, median {st.median(ch):+,.0f}, sum {sum(ch) / 1e3:+,.0f}K, "
                  f"without the 2 most hurt {sum(ch[2:]) / 1e3:+,.0f}K; by year " + ", ".join(f"{y} {sum(pt(r['cf']) - pt(r['ret']) for r in fails if r['key'][0][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026")))
    # ---- 3. Indi vs the bot vs random ----
    print("\n## 3. How often a sale (or buy) is at a level (within 0.25 S30), vs a random minute of the same stock-day\n")
    print("| Who | Events | At any level | Random minute | At yesterday's / 5-day level | Random minute |\n|---|---|---|---|---|---|")
    cache = {}
    def cx(s, d):
        if (s, d) not in cache: cache[(s, d)] = ctx(s, d)
        return cache[(s, d)]
    E = his_events()
    for kind in ("entry", "exit"):
        rows = [(cx(s, d), m) for k, s, d, m in E if k == kind and cx(s, d)]
        n, a, b, ra, rb = near_share(rows)
        print(f"| Indi, {kind} | {n} | {100 * a:.0f}% | {100 * ra:.0f}% | {100 * b:.0f}% | {100 * rb:.0f}% |")
    rows = [(cx(t["sym"], t["date"]), int(t["minute"])) for t in T if key(t) in R and t["sym"] in HIS40 and cx(t["sym"], t["date"])]
    n, a, b, ra, rb = near_share(rows)
    print(f"| Bot, entry | {n} | {100 * a:.0f}% | {100 * ra:.0f}% | {100 * b:.0f}% | {100 * rb:.0f}% |")
    ex = [z for t in T if key(t) in R and t["sym"] in HIS40 for z in R[key(t)]["exit_near"]]
    print(f"| Bot, same-day sale | {len(ex)} | {100 * sum(z <= NEAR for z in ex) / len(ex):.0f}% | (see random above) | | |")


if __name__ == "__main__":
    main()
