"""V2: the close trade with support / resistance and a hedged winner (the user, 2026-10-24, for the close trade, not the
champion). From eod3.py (the strongest stock at 15:55 on the day's C measure, top 20% of the range our way, 1-4 days
out, out the next morning). Set before running:

1. Levels at 15:55 (levels.py: yesterday's / the 5-day / the first 15 minutes' high (call) or low (put), S30 units):
     above   the stock is 0.25 S30 or more past a level it opened short of (it broke it today and holds it)
     stuck   in the last hour it came within 0.25 S30 of a level ahead (one of those, or the day's extreme made before
             14:55) and is now 0.5 S30 or more back from it, never 0.25 past it
   Candidate filters: L0 none (eod3), L1 above, L2 not stuck, L3 above and not stuck.
2. Exits the next session (a rule decides on a bar's close, sells on the next bar at the middle - 2%):
     M30     all at 10:00 (eod3's best)
     RUN     at 09:40, an option up +50% or more is kept: out 30% under its highest close since 09:40, else at 15:50;
             otherwise all at 10:00
     HEDGE   RUN, plus at 09:40 short (call) / buy (put) contracts x 100 x delta x 0.5 shares (delta from the 09:40
             option price), closed with the option; no stock costs counted
Day strength >= 1.5 / 2.0; delta 0.15 / 0.20 / 0.25. Fair list and 151 unseen (the Favorites year as a re-test).

  node --env-file=.env <path>/run.mjs eod5.py      (from the repo root) -> data/local/x/bt/eod5_trades.csv
"""
import csv, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("BT_UNIVERSE", "wide")
import sim
import news_filter as nf
from store import P, day, calendar, iv_delta, years_to_expiry
from signals import series, beta
from levels import ctx, NEAR, BREAK, BACK
from score_sum import account
from eod1 import LISTS, FAV, M
from eod3 import tstat, TOP

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
FLOORS = (1.5, 2.0)
DELTAS = (0.15, 0.20, 0.25)
FILTERS = ("L0", "L1", "L2", "L3")
EXITS = ("M30", "RUN", "HEDGE")
SH = sim.SH
EOD = 380
sim.C.update(dte_min=1, dte_max=4)


def level_marks(x, bet):
    """-> (above, stuck) at 15:55 for a call (bet 1) or a put (bet -1)."""
    c, unit = x["c"], x["sd"] * x["c"][M]
    first = next((v for v in c if v), None)
    hs, ls = [v for v in x["h"][:15] if v], [v for v in x["l"][:15] if v]
    fixed = [x["prev_hi"], x["p5_hi"], max(hs) if hs else None] if bet > 0 else [x["prev_lo"], x["p5_lo"], min(ls) if ls else None]
    fixed = [v for v in fixed if v]
    above = any(bet * (first - v) < 0 and bet * (c[M] - v) >= BREAK * unit for v in fixed)
    early = [v for v in (x["h"] if bet > 0 else x["l"])[:M - 60] if v]
    ahead = fixed + ([max(early) if bet > 0 else min(early)] if early else [])
    last = [c[m] for m in range(M - 60, M + 1) if c[m]]
    stuck = False
    for v in ahead:
        if bet * (v - c[M]) <= 0: continue
        touched = any(bet * (v - p) <= NEAR * unit for p in last)
        broke = any(bet * (p - v) >= BREAK * unit for p in last)
        if touched and not broke and bet * (v - c[M]) >= BACK * unit: stuck = True
    return above, stuck


def stock(sym):
    out = []
    for i, date in enumerate(CAL):
        if i < 21 or i + 1 >= len(CAL): continue
        if not any(a <= date <= b for f, (a, b) in LISTS.values()): continue
        exp = sim.expiry_for(sym, date)
        if not exp or exp <= date: continue
        x = ctx(sym, date)
        if x is None or x["c"][M] is None: continue
        b_ = beta(sym, date, i, CAL)
        if b_ is None: continue
        td = tstat(x["c"], series(day("SPY", date))[0], b_, 1)
        if td is None or abs(td) < min(FLOORS): continue
        hi = max(v for v in x["h"][:M + 1] if v); lo = min(v for v in x["l"][:M + 1] if v)
        pos = (x["c"][M] - lo) / (hi - lo) if hi > lo else 0.5
        bet = 1 if td > 0 else -1
        if (pos if bet > 0 else 1 - pos) < TOP: continue
        above, stuck = level_marks(x, bet)
        out.append(dict(date=date, sym=sym, day=td, close=x["c"][M], above=above, stuck=stuck, right="C" if bet > 0 else "P"))
    return out


def exits(sym, date, right, con, exp):
    nxt = CAL[IDX[date] + 1]; bet = 1 if right == "C" else -1
    sim.fetch_bars("options", [con], date, nxt)
    b0 = next((b for b in day(con, date) if M < b[0] <= 389), None)
    if not b0: return None, "no_fill"
    cost = sim.mid(b0) * (1 + SH)
    ob = day(con, nxt)
    if not ob: return None, "no_bars_next"
    sc = {b[0]: b[4] for b in day(sym, nxt)}
    stock_at = lambda m: next((sc[j] for j in range(m, -1, -1) if j in sc), None)
    sell = lambda b: max(sim.mid(b) * (1 - SH), 0.01)
    at = lambda m: next((b for b in ob if b[0] >= m), ob[-1])
    after = lambda m: next((b for b in ob if b[0] > m), ob[-1])
    m30 = sim.result(cost, [(nxt, 0, "sell", 1.0, sell(at(30)), "M30")])
    res = {"M30": m30, "RUN": m30, "HEDGE": m30, "kept": False}
    b10 = at(10)
    if b10[4] < cost * 1.5: return cost, res
    peak, out = b10[4], None
    for b in ob:
        if b[0] <= b10[0]: continue
        if b[0] >= EOD: break
        peak = max(peak, b[4])
        if b[4] <= peak * 0.7: out = b; break
        last = b
    exit_bar = after(out[0]) if out else at(EOD)
    run = sim.result(cost, [(nxt, 0, "sell", 1.0, sell(exit_bar), "RUN")])
    res.update(RUN=run, HEDGE=run, kept=True)
    s10, s1 = stock_at(b10[0]), stock_at(exit_bar[0])
    k = float(con[-8:]) / 1000
    x = iv_delta(b10[4], s10, k, years_to_expiry(nxt, b10[0], exp), sim.C["rate"], right == "C") if s10 else None
    if x and s1:
        res["HEDGE"] = run - bet * x[1] * 0.5 * (s1 - s10) / cost
    return cost, res


def trade(job):
    lname, date, floor, filt, d, cands = job
    sim.C.update(delta=d)
    for c in cands[:5]:
        best, why = sim.pick(c["sym"], date, M, c["right"], c["close"])
        if best is None: continue
        cost, res = exits(c["sym"], date, c["right"], best[0], best[1])
        if cost is None: continue
        return dict(list=lname, date=date, floor=floor, filt=filt, delta=d, sym=c["sym"], right=c["right"], t=round(c["day"], 2),
                    contract=best[0], cost=round(cost, 4), kept=res["kept"], **{k: round(res[k], 4) for k in EXITS})
    return None


def keep(r, filt):
    if filt == "L1": return r["above"]
    if filt == "L2": return not r["stuck"]
    if filt == "L3": return r["above"] and not r["stuck"]
    return True


def main():
    syms = sorted(set(P["universe"]) | set(FAV))
    with mp.Pool(8) as pool: parts = pool.map(stock, syms)
    R = [r for p in parts for r in p]
    nf.features(R)
    R = [r for r in R if r["e_next"] != 1]
    print(len(R), "candidate stock days; above support", sum(r["above"] for r in R), "stuck", sum(r["stuck"] for r in R), flush=True)
    jobs = []
    for lname, (lf, (A, Z)) in LISTS.items():
        by = {}
        for r in R:
            if A <= r["date"] <= Z and lf(r["sym"], r["date"]): by.setdefault(r["date"], []).append(r)
        for date, rows in sorted(by.items()):
            for floor in FLOORS:
                for filt in FILTERS:
                    C = sorted((r for r in rows if abs(r["day"]) >= floor and keep(r, filt)), key=lambda r: -abs(r["day"]))
                    if not C: continue
                    for d in DELTAS: jobs.append((lname, date, floor, filt, d, C))
    print(len(jobs), "list days x versions", flush=True)
    with mp.Pool(8) as pool: rows = [r for r in pool.imap(trade, jobs, chunksize=8) if r]
    with open(f"{B}/eod5_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    summary(rows)


def summary(rows=None):
    if rows is None: rows = list(csv.DictReader(open(f"{B}/eod5_trades.csv")))
    for lname in LISTS:
        print(f"\n### {lname} (trades / kept at 09:40 / winners / per trade at $10K 2024 2025 2026 / account at 1% / worst drop / without best 5)")
        for floor in FLOORS:
            for filt in FILTERS:
                for d in DELTAS:
                    L = sorted((r for r in rows if r["list"] == lname and float(r["floor"]) == floor and r["filt"] == filt and float(r["delta"]) == d), key=lambda r: r["date"])
                    if not L: continue
                    kept = sum(str(r["kept"]) == "True" for r in L)
                    for ex in EXITS:
                        # bought after 15:50, sold the next session: booked then (score_sum.account)
                        pn = [dict(date=r["date"], pnl=str(1e4 * max(-1, float(r[ex]))),
                                   exit_day=CAL[IDX[r["date"]] + 1]) for r in L]
                        a1, d1 = account(pn)
                        top = set(sorted(range(len(pn)), key=lambda k: -float(pn[k]["pnl"]))[:5])
                        a5, _ = account([p for k, p in enumerate(pn) if k not in top])
                        win = sum(float(r[ex]) > 0 for r in L) / len(L)
                        yr = " ".join(f"{st.fmean([float(p['pnl']) for p in pn if p['date'][:4] == y] or [0]):+,.0f}" for y in ("2024", "2025", "2026"))
                        print(f"t{floor} {filt} d{d} {ex:5} | {len(L)} / {kept} / {100 * win:.0f}% / {yr} / ${a1:,.0f} / {100 * d1:.0f}% / wo5 ${a5:,.0f}")


if __name__ == "__main__":
    summary() if sys.argv[1:] == ["summary"] else main()
