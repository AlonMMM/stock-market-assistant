"""The live Volume bot's rule with the contract fallbacks and lower liquidity floors, on the bigger watchlist (the user,
2026-10-26: "now we have like 160 tickers ... a lot of them have low liquidity and some of them have a cheap price ...
maybe the result will be changed"). The rule as live: 0DTE + 1DTE (out by 15:30), the side at 0.25 S30 within 10
minutes, the 0.35-delta leg, sold on the 0.75 S30 give-back; re-entry once flat, up to 2 trades a stock a day; 1%,
±2% (±4% as a check); with and without the live limits (15 trades a day, 5 open, 7.5% day loss). The pick, by mode:
  plain    $0.20 and 200 contracts in the last 30 minutes, or no trade (the bot now)
  cheap    under $0.20: the cheapest strike nearer the money at $0.20 or more (the Main bot's cheap fallback)
  liquid   under 200 contracts: further out (to delta 0.25), then toward the money (to 0.50), with 200 and $0.20
  both     cheap, then liquid
  v100/v50 plain with a floor of 100 / 50 contracts;  cheap100  cheap with the 100 floor

  BT_UNIVERSE=watch BT_ALL=1 node --env-file=.env <path>/run.mjs leg_fb2.py
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day
from levels import ctx
from rvol_alert import alerts_for
from zero5 import FIRST, LAST
from cheap_up import candidates
import leg_twice as TW
import leg_fallback as LF
import leg_daycap as D

C = sim.C
CAL = TW.CAL
MODES = {"plain": ("plain", 200), "cheap": ("cheap", 200), "liquid": ("liquid", 200), "both": ("both", 200),
         "v100": ("plain", 100), "v50": ("plain", 50), "cheap100": ("cheap", 100)}
# Another target delta (the user, 2026-10-26: "check if we have different results with delta of 0.2 or 0.25 or
# 0.15 ... with the cheapest fallback and the liquid fallback"). The liquid band moves with it: further out to the
# target - 0.10, toward the money to 0.50 (the live bot's band is 0.25-0.50 around 0.35).
if os.environ.get("BT_DELTA"):
    TW.DELTA = LF.DELTA = float(os.environ["BT_DELTA"])
    LF.LOW = max(0.05, TW.DELTA - 0.10)
    MODES = {k: MODES[k] for k in ("plain", "cheap", "liquid", "both")}


def one(job):
    date, sym, kind = job
    al = alerts_for(sym, date, CAL)
    if not al: return None
    ev = [(q, al[q]) for q in range(FIRST, LAST + 1) if al[q] and not al[q - 1]]
    if not ev: return None
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if not x or not x.get("sd"): return None
    u = x["sd"]
    if kind == "0": C.update(dte_min=0, dte_max=0, delta=TW.DELTA)
    else: C.update(dte_min=1, dte_max=5, delta=TW.DELTA)
    nxt = CAL[CAL.index(date) + 1] if kind == "1" else date
    per = {m: [] for m in MODES}
    for n, (m, side_al) in enumerate(ev):
        if m not in sb: continue
        stock0 = sb[m][4]; side = None
        for t in range(m + 1, m + TW.WAIT + 1):
            if t in sb and abs(sb[t][4] / stock0 - 1) >= TW.K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
        cands = []
        if side:
            ct, right = side; spot = sb[ct][4]
            got, why = sim.pick(sym, date, ct, right, spot)   # fills the cache with the chain's bars
            if why not in ("no_expiry", "no_strikes"):
                cands = [c for c in candidates(sym, date, ct, right, spot) if c[1] == nxt]
        for name, (mode, floor) in MODES.items():
            tr = None
            if cands:
                C["min_vol30"] = floor
                c = LF.choose(cands, mode)
                C["min_vol30"] = 200
                if c:
                    w = LF.walk(sym, date, ct, right, c[0], spot, u)
                    if w: tr = dict(buy=w[0], sell=w[1], bm=w[2], xm=w[3], ct=ct, contract=c[0], price=c[4], vol30=c[5])
            per[name].append(dict(n=n, minute=m, trade=tr))
    return dict(first_minute=ev[0][0], modes=per)


def main():
    import news_filter as nf
    lo_d, hi_d = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    jobs = [j for j in TW.days() if lo_d <= j[0] <= hi_d]
    with mp.Pool(8) as pool: res = pool.map(one, jobs, chunksize=4)
    rows = [dict(date=j[0], sym=j[1], minute=r["first_minute"], right="C", r=r) for j, r in zip(jobs, res) if r]
    nf.features(rows)
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    for lab, lo in (("3 years (Feb 2024 - Oct 2026)", "0000"), ("12 months", "2025-10-23"), ("6 months", "2026-04-23")):
        print(f"\n### {lab}\n\n| Pick | Trades | Added vs plain (their P&L) | No limits: end, worst drop | without best 5 | ±4% | Live limits: end, worst drop |\n|---|---|---|---|---|---|---|")
        base = None
        for name in MODES:
            T = []
            for t in keep:
                if t["date"] < lo: continue
                for e in TW.pick(dict(events=t["r"]["modes"][name]), "flat")[:2]:
                    T.append(dict(date=t["date"], sym=t["sym"], minute=e["minute"], contract=e["trade"]["contract"], **{k: e["trade"][k] for k in ("buy", "sell", "bm", "xm")}))
            e1, d1, R, _, _ = D.account(T, 1, 2)
            top = {(r["date"], r["sym"], r["minute"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
            e5 = D.account([t for t in T if (t["date"], t["sym"], t["minute"]) not in top], 1, 2)[0]
            e4 = D.account(T, 1, 4)[0]
            eL, dL, _, _, _ = D.account(T, 1, 2, loss=7.5, max_trades=15, max_open=5)
            keys = {(r["date"], r["sym"], r["minute"], r["contract"]) for r in R}
            if base is None: base = keys
            new = [r for r in R if (r["date"], r["sym"], r["minute"], r["contract"]) not in base]
            print(f"| {name} | {len(R)} | {len(new)} ({sum(r['pnl'] for r in new):+,.0f}) | ${e1:,.0f}, {100 * d1:.1f}% | ${e5:,.0f} | ${e4:,.0f} | ${eL:,.0f}, {100 * dL:.1f}% |", flush=True)

    if os.environ.get("BT_EXPORT"):   # for the benchmark page: set re2liq (the bot now + the liquid fallback)
        import csv
        from leg_export import path_rows
        out, lst = os.environ["BT_EXPORT"], os.environ.get("BT_LIST", "watch")
        T, PT, seen = [], [], set()
        # BT_EXPORT_SETS: mode:set pairs, e.g. "liquid:liq20,both:both20"; the default is the bot now
        pairs = [x.split(":") for x in os.environ.get("BT_EXPORT_SETS", "liquid:re2liq").split(",")]
        for (mode, setname), t in ((p, t) for p in pairs for t in sorted(keep, key=lambda t: t["date"])):
            for e in TW.pick(dict(events=t["r"]["modes"][mode]), "flat")[:2]:
                x = e["trade"]; pid = f"{lst}|{t['date']}|{t['sym']}|{x['contract']}"
                T.append(dict(key=f"{setname}|{pid}|{e['minute']}", set=setname, list=lst, pid=pid, date=t["date"], sym=t["sym"], minute=e["minute"],
                              alert="", prev_date=CAL[CAL.index(t["date"]) - 1], sd30="", stock_at_alert="", kept="call" if x["contract"][-9] == "C" else "put",
                              side_minute=x["ct"], leg=x["contract"], delta="", buy_minute=x["bm"], buy_price=round(x["buy"], 4),
                              exit_day="t", exit_minute=x["xm"], exit_price=round(x["sell"], 4), half_minute="", half_price=""))
                if pid not in seen:
                    seen.add(pid); PT.extend(dict(pid=pid, **r) for r in path_rows(t["sym"], t["date"], x["contract"], False))
        tag = os.environ.get("BT_EXPORT_TAG", "liq")
        for name, data in ((f"trades_{lst}_{tag}", T), (f"paths_{lst}_{tag}", PT)):
            with open(f"{out}/{name}.csv", "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(data[0])); w.writeheader(); w.writerows(data)
            print(name, len(data), "rows", flush=True)


if __name__ == "__main__":
    main()
