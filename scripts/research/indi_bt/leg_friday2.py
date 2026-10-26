"""The Friday option early in the week, part 2 (the user, 2026-10-26: "Test it [Wednesday only, with live spreads].
Also test the case of overnight like we have in the main bot only for Monday Tuesday for Friday trades").
As leg_friday.py (the live rule, the Friday option on a Mon-Wed with no expiry today or the next session, 0.35, the
liquid fallback, re-entry 2 a stock a day), by day:
  wed      Wednesday, out the same day (2 days to expiry)
  mt_day   Monday / Tuesday, out the same day
  mt_night Monday / Tuesday with the overnight rule (leg_1dte.walk 'b1hc', the Main bot's way): once the leg is
           +50% the day's give-back stops; held overnight if still +50% at the close (else sold there); next morning,
           up from the close: half sold, the rest on the give-back; down: all sold; out by 15:30.
Each added to the bot now's trades (bench trades.csv, watch: re2liq for the ±2% / ±4% fills, spnow for live spreads,
leg_spread.py's model) at the live limits (15 a day, 5 open, 7.5% day loss); a leg held overnight counts as open
to the close.

  BT_UNIVERSE=watch BT_ALL=1 BT_FROM=2025-10-23 node --env-file=.env <path>/run.mjs leg_friday2.py <trades.csv>
"""
import csv, datetime as dt, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day
from levels import ctx
from rvol_alert import alerts_for
from zero5 import FIRST, LAST
from cheap_up import candidates
import leg_1dte as L1
import leg_twice as TW
import leg_fallback as LF
import leg_daycap as D
import leg_spread as SP
from leg_friday import days, friday_of

C = sim.C
CAL = TW.CAL


def one(job):
    date, sym = job
    wd = dt.date.fromisoformat(date).weekday()
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
    modes = ["wed"] if wd == 2 else ["mt_day", "mt_night"]
    per = {m: [] for m in modes}
    for n, (m, side_al) in enumerate(ev):
        if m not in sb: continue
        stock0 = sb[m][4]; side = None
        for t in range(m + 1, m + TW.WAIT + 1):
            if t in sb and abs(sb[t][4] / stock0 - 1) >= TW.K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
        c = None
        if side:
            ct, right = side; spot = sb[ct][4]
            got, why = sim.pick(sym, date, ct, right, spot)
            if why not in ("no_expiry", "no_strikes"):
                cands = [k for k in candidates(sym, date, ct, right, spot) if k[1] == fri]
                c = LF.choose(cands, "liquid") if cands else None
        for mode in modes:
            tr = None
            if c:
                if mode == "mt_night":
                    w = L1.walk(sym, date, ct, right, c[0], spot, u, None, "b1hc")
                    if w: tr = dict(buy=w[0], sell=w[1], bm=w[3]["b"], xm=999 if w[2] else w[3]["m"], ct=ct, contract=c[0], night=bool(w[2]))
                else:
                    w = LF.walk(sym, date, ct, right, c[0], spot, u)
                    if w: tr = dict(buy=w[0], sell=w[1], bm=w[2], xm=w[3], ct=ct, contract=c[0], night=False)
                if tr:   # the live-spread prices too (leg_spread.py: one spread level per stock and day)
                    q = SP.level(c[0], date)
                    mb, ms = tr["buy"] / (1 + LF.SH), tr["sell"] / (1 - LF.SH)
                    tr["buy_sp"] = mb * (1 + SP.spread(mb, q) / 2)
                    tr["sell_sp"] = max(ms * (1 - SP.spread(max(ms, 0.01), q) / 2), 0.0)
            per[mode].append(dict(n=n, minute=m, trade=tr))
    return dict(first_minute=ev[0][0], modes=per)


def main():
    import news_filter as nf
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    jobs = [j for j in days() if lo <= j[0] <= hi]
    with mp.Pool(8) as pool: res = pool.map(one, jobs, chunksize=4)
    rows = [dict(date=j[0], sym=j[1], minute=r["first_minute"], right="C", r=r) for j, r in zip(jobs, res) if r]
    nf.features(rows)
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    add = {"wed": [], "mt_day": [], "mt_night": []}
    for t in keep:
        for mode, evs in t["r"]["modes"].items():
            for e in TW.pick(dict(events=evs), "flat")[:2]:
                x = e["trade"]
                add[mode].append(dict(date=t["date"], sym=t["sym"], minute=e["minute"], fri=True, night=x["night"], bm=x["bm"], xm=x["xm"],
                                      buy=x["buy"], sell=x["sell"], buy_sp=x["buy_sp"], sell_sp=x["sell_sp"]))
    base = {}
    for r in csv.DictReader(open(sys.argv[1])):
        if r["list"] != "watch" or not lo <= r["date"] <= hi or r["set"] not in ("re2liq", "spnow"): continue
        base.setdefault(r["set"], []).append(dict(date=r["date"], sym=r["sym"], minute=int(r["minute"]), fri=False, night=False,
                                                   buy=float(r["buy_price"]), sell=float(r["exit_price"]), bm=int(r["buy_minute"]), xm=int(r["exit_minute"])))
    sp = lambda T: [dict(t, buy=t.get("buy_sp", t["buy"]), sell=t.get("sell_sp", t["sell"])) for t in T]
    print("\n| Account | Added trades (held overnight) | ±2%: end, worst drop | ±4% | Live spreads: end, worst drop |\n|---|---|---|---|---|")
    for lab, extra in (("the bot now", []), ("+ Wednesday, same day", add["wed"]), ("+ Mon/Tue, same day", add["mt_day"]),
                       ("+ Mon/Tue, overnight rule", add["mt_night"]), ("+ Wednesday + Mon/Tue overnight", add["wed"] + add["mt_night"])):
        lim = dict(loss=7.5, max_trades=15, max_open=5)
        e2, d2, R, _, _ = D.account(base["re2liq"] + extra, 1, 2, **lim)
        e4 = D.account(base["re2liq"] + extra, 1, 4, **lim)[0]
        es, ds, _, _, _ = D.account(base["spnow"] + sp(extra), 1, 2, **lim)
        n = sum(1 for r in R if r["fri"]); nn = sum(1 for r in R if r["fri"] and r["night"])
        print(f"| {lab} | {n} ({nn}) | ${e2:,.0f}, {100 * d2:.1f}% | ${e4:,.0f} | ${es:,.0f}, {100 * ds:.1f}% |", flush=True)
    print("\n| Added trades alone, no limits | Trades | Winners | Avg at 1%, ±2% | Avg, live spreads |\n|---|---|---|---|---|")
    for mode in ("wed", "mt_day", "mt_night"):
        _, _, R, _, _ = D.account(add[mode], 1, 2)
        _, _, Rs, _, _ = D.account(sp(add[mode]), 1, 2)
        if R: print(f"| {mode} | {len(R)} | {100 * sum(r['pnl'] > 0 for r in R) / len(R):.0f}% | {sum(r['pnl'] for r in R) / len(R):+,.0f} | {sum(r['pnl'] for r in Rs) / max(1, len(Rs)):+,.0f} |")


if __name__ == "__main__":
    main()
