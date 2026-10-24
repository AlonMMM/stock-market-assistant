"""V2: the close trade (the user's idea, 2026-10-24). At 15:55 New York (22:55 Israel), take the best stock of the list
against SPY and on volume in the last hour, if it is at its day high (call) or low (put) and has not fallen back from
it, and buy a contract that expires the next session. Sell the next morning. Set before running:

Candidates at 15:55 (minute 385), each stock of the list:
  strength  t-stat of the 1-minute moves vs SPY x beta over 14:55-15:55, our way (call when > 0, put when < 0)
  volume    the volume of 14:55-15:55 vs its median over the 20 sessions before
  at the high: the close is within `near` S30 of the day's high (call) / low (put) so far (S30 as in levels.py)
  an expiry the next session (else the stock is not a candidate); no earnings reaction tomorrow
The best = the lowest rank sum of strength and volume among the candidates (ties: the higher strength). When its
contract fails the price / volume minimums, the next best, up to 5. One trade a day per list.
Versions: near 0.25 / 0.5 S30; floors none / (t >= 1.5 and volume >= 1.2x); delta 0.15 / 0.20 / 0.25.
Fill on the next bar (15:56-15:59) at the middle + 2%. Exits the next session (sales at the next bar's middle - 2%):
  OPEN    all on the first bar
  M10     all at 09:40
  GAP     the champion's morning rule: at 09:40, the stock 0.5%+ our way from yesterday's close -> half, the rest
          out at -30% or at 15:30; otherwise all
  TP50    from the open: all at +50% or at -30% (decided on a bar's close), else all at 10:30
  TP100   the same with +100%
Lists: the fair list and the 151 unseen (2024-02 to 2026-10-12), and the user's Favorites (2025-10-23 to
2026-10-22). 1% / 2% of the start-of-day account from $100,000.

  node --env-file=.env <path>/run.mjs eod1.py      (from the repo root) -> data/local/x/bt/eod1_trades.csv
"""
import csv, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("BT_UNIVERSE", "wide")
import sim
import news_filter as nf
from store import P, day, calendar
from signals import series, beta
from levels import ctx
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
M, H0 = 385, 326  # 15:55, and the hour from 14:56
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
FAV = "AAPL,AMZN,ASTS,AVGO,BA,BABA,CAT,COIN,CRM,CRWD,CRWV,CVX,F,GOOGL,HIMS,HOOD,IBIT,IBKR,IBM,IONQ,IREN,LLY,META,MRNA,MSFT,MSTR,MU,NOW,NU,NVDA,NVO,ON,ONDS,ORCL,OWL,PLTR,QCOM,RKLB,SIRI,SKHY,SMCI,SNDK,SOFI,SOXX,SPCX,TSLA,UAL,UBER,VKTX,WIX,WMT".split(",")
LISTS = {
    "fair": (lambda s, d: s in HIS40 and s in PRIOR[d[:4]], ("2024-02-01", "2026-10-12")),
    "unseen": (lambda s, d: s not in HIS40, ("2024-02-01", "2026-10-12")),
    "favorites": (lambda s, d: s in FAV, ("2025-10-23", "2026-10-22")),
}
NEARS = (0.25, 0.5)
FLOORS = {"none": (0.0, 0.0), "t1.5v1.2": (1.5, 1.2)}
DELTAS = (0.15, 0.20, 0.25)
EXITS = ("OPEN", "M10", "GAP", "TP50", "TP100")
SH = sim.SH
sim.C.update(dte_min=1, dte_max=4)


def stock(sym):
    """-> per day: the stock's 15:55 measures {date, sym, t, rv, dist_hi, dist_lo, close}."""
    out = []
    for i, date in enumerate(CAL):
        if i < 21 or i + 1 >= len(CAL): continue
        if not any(a <= date <= b for f, (a, b) in LISTS.values()): continue
        if sim.expiry_for(sym, date) != CAL[i + 1]: continue  # no contract for the next session
        x = ctx(sym, date)
        if x is None: continue
        c = x["c"]
        if c[M] is None: continue
        b_ = beta(sym, date, i, CAL)
        if b_ is None: continue
        spy = series(day("SPY", date))[0]
        n = s1 = s2 = 0.0
        for m in range(H0, M + 1):
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                r = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
                n += 1; s1 += r; s2 += r * r
        if n < 20: continue
        mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
        t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
        hv = []
        for d in CAL[i - 20:i]:
            v = sum(b[5] for b in day(sym, d) if H0 <= b[0] <= M)
            if v > 0: hv.append(v)
        if len(hv) < 10: continue
        rv = sum(b[5] for b in day(sym, date) if H0 <= b[0] <= M) / st.median(hv)
        hi = max(v for v in x["h"][:M + 1] if v); lo = min(v for v in x["l"][:M + 1] if v)
        unit = x["sd"] * c[M]
        out.append(dict(date=date, sym=sym, t=t, rv=rv, dist_hi=(hi - c[M]) / unit, dist_lo=(c[M] - lo) / unit, close=c[M]))
    return out


def exits(sym, date, right, con, exp):
    """-> (cost, {exit: ret}) for one contract bought at 15:55 and sold the next session, or (None, reason)."""
    bet = 1 if right == "C" else -1
    nxt = CAL[IDX[date] + 1]
    sim.fetch_bars("options", [con], date, nxt)
    b0 = next((b for b in day(con, date) if M < b[0] <= 389), None)
    if not b0: return None, "no_fill"
    cost = sim.mid(b0) * (1 + SH)
    ob = day(con, nxt)
    if not ob: return None, "no_bars_next"
    sb = {b[0]: b[4] for b in day(sym, nxt)}
    yc = day(sym, date)[-1][4]
    sell = lambda b: max(sim.mid(b) * (1 - SH), 0.01)
    at = lambda m: next((b for b in ob if b[0] >= m), ob[-1])
    after = lambda m: next((b for b in ob if b[0] > m), ob[-1])
    res = {}
    res["OPEN"] = [(1.0, sell(ob[0]))]
    res["M10"] = [(1.0, sell(at(10)))]
    s10 = next((sb[m] for m in range(10, -1, -1) if m in sb), None)
    gap = bet * (s10 / yc - 1) * 100 if s10 else -1
    if gap >= 0.5:
        rest = next((after(b[0]) for b in ob if b[0] > 10 and b[4] <= cost * 0.7), None) or at(360)
        res["GAP"] = [(0.5, sell(at(10))), (0.5, sell(rest))]
    else:
        res["GAP"] = [(1.0, sell(at(10)))]
    for name, take in (("TP50", 0.5), ("TP100", 1.0)):
        hit = next((b for b in ob if b[0] < 60 and (b[4] >= cost * (1 + take) or b[4] <= cost * 0.7)), None)
        res[name] = [(1.0, sell(after(hit[0]) if hit else at(60)))]
    out = {}
    for k, sales in res.items():
        steps = [(nxt, 0, "sell", q, p, k) for q, p in sales]
        out[k] = sim.result(cost, steps)
    return cost, out


def trade(job):
    """One list day, version: walk down the ranked candidates until one contract passes. -> row or None."""
    lname, date, near, fname, d, cands = job
    sim.C.update(delta=d)
    for c in cands[:5]:
        best, why = sim.pick(c["sym"], date, M, c["right"], c["close"])
        if best is None: continue
        cost, res = exits(c["sym"], date, c["right"], best[0], best[1])
        if cost is None: continue
        return dict(list=lname, date=date, near=near, floor=fname, delta=d, sym=c["sym"], right=c["right"], t=round(c["t"], 2),
                    rv=round(c["rv"], 2), contract=best[0], cost=round(cost, 4), **{k: round(v, 4) for k, v in res.items()})
    return None


def main():
    syms = sorted(set(P["universe"]) | set(FAV))
    with mp.Pool(8) as pool: parts = pool.map(stock, syms)
    R = [r for p in parts for r in p]
    for r in R: r["right"] = "C" if r["t"] > 0 else "P"
    nf.features(R)
    R = [r for r in R if r["e_next"] != 1]  # no earnings reaction tomorrow
    print(len(R), "stock days with a next-session expiry", flush=True)
    jobs = []
    for lname, (lf, (A, Z)) in LISTS.items():
        days = sorted({r["date"] for r in R if A <= r["date"] <= Z})
        by = {}
        for r in R:
            if A <= r["date"] <= Z and lf(r["sym"], r["date"]): by.setdefault(r["date"], []).append(r)
        for date in days:
            for near in NEARS:
                for fname, (ft, fv) in FLOORS.items():
                    C = []
                    for r in by.get(date, []):
                        dist = r["dist_hi"] if r["right"] == "C" else r["dist_lo"]
                        if dist <= near and abs(r["t"]) >= ft and r["rv"] >= fv: C.append(r)
                    if not C: continue
                    rt = {id(r): k for k, r in enumerate(sorted(C, key=lambda r: -abs(r["t"])))}
                    rvr = {id(r): k for k, r in enumerate(sorted(C, key=lambda r: -r["rv"]))}
                    C.sort(key=lambda r: (rt[id(r)] + rvr[id(r)], -abs(r["t"])))
                    for d in DELTAS: jobs.append((lname, date, near, fname, d, C))
    print(len(jobs), "list days x versions", flush=True)
    with mp.Pool(8) as pool: rows = [r for r in pool.imap(trade, jobs, chunksize=8) if r]
    with open(f"{B}/eod1_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    summary(rows)


def summary(rows=None):
    if rows is None: rows = list(csv.DictReader(open(f"{B}/eod1_trades.csv")))
    for lname in LISTS:
        print(f"\n### {lname} (trades / winners / per trade at $10K 2024 2025 2026 / account at 1% / worst drop / at 2% / without best 5)")
        for near in NEARS:
            for fname in FLOORS:
                for d in DELTAS:
                    L = sorted((r for r in rows if r["list"] == lname and float(r["near"]) == near and r["floor"] == fname and float(r["delta"]) == d), key=lambda r: r["date"])
                    if not L: continue
                    for ex in EXITS:
                        pn = [dict(date=r["date"], pnl=str(1e4 * max(-1, float(r[ex])))) for r in L]
                        a1, d1 = account(pn); a2, d2 = account(pn, 0.02)
                        top = sorted(range(len(pn)), key=lambda k: -float(pn[k]["pnl"]))[:5]
                        a5, _ = account([p for k, p in enumerate(pn) if k not in top])
                        win = sum(float(r[ex]) > 0 for r in L) / len(L)
                        yr = " ".join(f"{st.fmean([float(p['pnl']) for p in pn if p['date'][:4] == y] or [0]):+,.0f}" for y in ("2024", "2025", "2026"))
                        print(f"near {near} {fname:9} d{d} {ex:6} | {len(L)} / {100 * win:.0f}% / {yr} / ${a1:,.0f} / {100 * d1:.0f}% / ${a2:,.0f} / wo5 ${a5:,.0f}")


if __name__ == "__main__":
    summary() if sys.argv[1:] == ["summary"] else main()
