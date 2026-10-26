"""The Friday option early in the week (the user, 2026-10-26: "test ... the Friday option only for stocks that
don't trade options in other days ... only on Monday, Tuesday and Wednesday, and let me know if it's helping").
The live Volume bot rule (side at 0.25 S30 in 10 minutes, 0.35 delta, the liquid fallback, re-entry 2 a stock a
day, 0.75 S30 give-back, out by 15:30 the same day, 1%, ±2%); on a Monday-Wednesday when the stock has no expiry
today or the next session, it buys that week's Friday option (2-4 days out) instead of skipping. The account adds
these trades to the bot now's (bench trades.csv set re2liq, list watch) under the live limits (15 a day, 5 open,
7.5% day loss).

  BT_UNIVERSE=watch BT_ALL=1 BT_FROM=2025-10-23 node --env-file=.env <path>/run.mjs leg_friday.py <trades.csv>
"""
import csv, datetime as dt, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day
from levels import ctx
from rvol_alert import alerts_for
from zero5 import SPAN, FIRST, LAST
from cheap_up import candidates
import leg_1dte as L1
import leg_twice as TW
import leg_fallback as LF
import leg_daycap as D

C = sim.C
CAL = TW.CAL


def friday_of(date):
    d = dt.date.fromisoformat(date)
    return (d + dt.timedelta(days=4 - d.weekday())).isoformat()


def days():
    out = []
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            if dt.date.fromisoformat(date).weekday() > 2 or L1.kind_of(sym, date): continue
            C.update(dte_min=2, dte_max=4)
            if sim.expiry_for(sym, date) == friday_of(date): out.append((date, sym))
    return out


def one(job):
    date, sym = job
    al = alerts_for(sym, date, CAL)
    if not al: return None
    ev = [(q, al[q]) for q in range(FIRST, LAST + 1) if al[q] and not al[q - 1]]
    if not ev: return None
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if not x or not x.get("sd"): return None
    u = x["sd"]
    C.update(dte_min=2, dte_max=4, delta=0.35)
    fri = friday_of(date)
    events = []
    for n, (m, side_al) in enumerate(ev):
        if m not in sb: continue
        stock0 = sb[m][4]; side = None
        for t in range(m + 1, m + TW.WAIT + 1):
            if t in sb and abs(sb[t][4] / stock0 - 1) >= TW.K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
        tr = None
        if side:
            ct, right = side; spot = sb[ct][4]
            got, why = sim.pick(sym, date, ct, right, spot)
            if why not in ("no_expiry", "no_strikes"):
                cands = [c for c in candidates(sym, date, ct, right, spot) if c[1] == fri]
                c = LF.choose(cands, "liquid") if cands else None
                if c:
                    w = LF.walk(sym, date, ct, right, c[0], spot, u)
                    if w: tr = dict(buy=w[0], sell=w[1], bm=w[2], xm=w[3], ct=ct, contract=c[0])
        events.append(dict(n=n, minute=m, trade=tr))
    return dict(first_minute=ev[0][0], events=events)


def main():
    import news_filter as nf
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    jobs = [j for j in days() if lo <= j[0] <= hi]
    print(len(jobs), "stock-days with a Friday option and no expiry today or tomorrow, Mon-Wed", flush=True)
    with mp.Pool(8) as pool: res = pool.map(one, jobs, chunksize=4)
    rows = [dict(date=j[0], sym=j[1], minute=r["first_minute"], right="C", r=r) for j, r in zip(jobs, res) if r]
    nf.features(rows)
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    F = []
    for t in keep:
        for e in TW.pick(t["r"], "flat")[:2]:
            F.append(dict(date=t["date"], sym=t["sym"], minute=e["minute"], fri=True, **{k: e["trade"][k] for k in ("buy", "sell", "bm", "xm")}))
    B = [dict(date=r["date"], sym=r["sym"], minute=int(r["minute"]), fri=False, buy=float(r["buy_price"]), sell=float(r["exit_price"]), bm=int(r["buy_minute"]), xm=int(r["exit_minute"]))
         for r in csv.DictReader(open(sys.argv[1])) if r["list"] == "watch" and r["set"] == "re2liq" and lo <= r["date"] <= hi]
    print("\n| Account | Trades | Friday-option trades | Live limits: end, worst drop | without best 5 | ±4%, live limits |\n|---|---|---|---|---|---|")
    for lab, T in (("the bot now", B), ("+ the Friday option Mon-Wed", B + F), ("the Friday-option trades alone", F)):
        eL, dL, R, _, _ = D.account(T, 1, 2, loss=7.5, max_trades=15, max_open=5)
        top = {(r["date"], r["sym"], r["minute"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
        e5 = D.account([t for t in T if (t["date"], t["sym"], t["minute"]) not in top], 1, 2, loss=7.5, max_trades=15, max_open=5)[0]
        e4 = D.account(T, 1, 4, loss=7.5, max_trades=15, max_open=5)[0]
        print(f"| {lab} | {len(R)} | {sum(1 for r in R if r['fri'])} | ${eL:,.0f}, {100 * dL:.1f}% | ${e5:,.0f} | ${e4:,.0f} |", flush=True)
    _, _, R, _, _ = D.account(F, 1, 2)
    names = ["Mon", "Tue", "Wed"]
    print("\n| Day | Friday-option trades | Winners | Avg P&L at 1% | Total |\n|---|---|---|---|---|")
    for i, nm in enumerate(names):
        G = [r for r in R if dt.date.fromisoformat(r["date"]).weekday() == i]
        if G: print(f"| {nm} | {len(G)} | {100 * sum(r['pnl'] > 0 for r in G) / len(G):.0f}% | {sum(r['pnl'] for r in G) / len(G):+,.0f} | {sum(r['pnl'] for r in G):+,.0f} |")


if __name__ == "__main__":
    main()
