"""The Alert leg benchmark, exported for its page (the user, 2026-10-25: "show me artifact with the benchmark").
Every version tested on 2026-10-25, the rule as the live bot runs it (the leg picked at the side), one row per trade
in trades.csv (`set` says which trades a version takes, the page builds each version from its sets):
  plain                  0DTE days, the 0.35 leg at the side, out on the 0.75 give-back or 15:30 (the bot today)
  cheap / liquid / both  the trades the contract fallbacks add on 0DTE days (leg_fallback.py)
  d1                     1DTE days, the next-day leg, out by 15:30 (leg_1dte.py 1d_day)
  b1 / b1f / b1hc        1DTE days, run overnight from +50% / with the +20% floor / with the morning rule
and paths.csv for the trade window: the stock and SPY every 5 minutes the day before, every 2 minutes on the trade
day (the leg too), every 5 minutes on the next day for the trades held overnight.

  BT_UNIVERSE=wide node --env-file=.env <path>/run.mjs leg_export.py <out dir> fair
  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node ... leg_export.py <out dir> fav
"""
import csv, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar, fetch_bars
from levels import ctx
from rvol_alert import alerts_for
from zero5 import SPAN, FIRST, LAST
from cheap_up import candidates
import leg_1dte as L1
import leg_fallback as LF
from signals import series

CAL = calendar()
C = sim.C
DELTA, K, WAIT = 0.35, 0.25, 60
ONE_D = (("d1", None), ("b1", "b1"), ("b1f", "b1f"), ("b1hc", "b1hc"))


def entries():
    ent = []
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            k = L1.kind_of(sym, date)
            if not k: continue
            al = alerts_for(sym, date, CAL)
            if not al: continue
            m = next((q for q in range(FIRST, LAST + 1) if al[q]), None)
            if m is not None: ent.append((date, sym, m, k, al[m]))
    return ent


def path_rows(sym, date, contract, nights):
    i = CAL.index(date); prev, nxt = CAL[i - 1], CAL[i + 1]
    out = []
    for d, dd, step in (("p", prev, 5), ("t", date, 2)) + ((("n", nxt, 5),) if nights else ()):
        sc, yc = series(day(sym, dd))[0], series(day("SPY", dd))[0]
        ob = {b[0]: b for b in day(contract, dd)} if d != "p" else {}
        lo = None
        for mm in range(390):
            if mm in ob: lo = ob[mm][4]
            if mm % step != step - 1 and mm != 389: continue
            if d == "n" and mm > 380: break
            out.append(dict(d=d, m=mm, s=round(sc[mm], 3) if sc[mm] else "", y=round(yc[mm], 3) if yc[mm] else "", o="" if lo is None else round(lo, 3)))
    return out


def one(sig):
    date, sym, m, kind, alert = sig
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if m not in sb or not x or not x.get("sd"): return None
    u, stock0 = x["sd"], sb[m][4]
    side = None
    for t in range(m + 1, m + WAIT + 1):
        if t in sb and abs(sb[t][4] / stock0 - 1) >= K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
    if not side: return None
    ct, right = side; spot = sb[ct][4]
    base = dict(date=date, sym=sym, minute=m, alert=alert, prev_date=CAL[CAL.index(date) - 1], sd30=round(u * 100, 3),
                stock_at_alert=round(stock0, 2), kept="call" if right == "C" else "put", side_minute=ct)
    rows, paths = [], {}
    if kind == "0":
        C.update(dte_min=0, dte_max=0, delta=DELTA)
        first, why = sim.pick(sym, date, ct, right, spot)
        if first is None and why not in ("too_cheap", "illiquid"): return None
        cands = candidates(sym, date, ct, right, spot)
        plain = LF.choose(cands, "plain")
        for mode in ("plain", "cheap", "liquid", "both"):
            c = LF.choose(cands, mode)
            if not c or (mode != "plain" and plain): continue   # a fallback set holds only the trades it adds
            w = LF.walk(sym, date, ct, right, c[0], spot, u)
            if not w: continue
            rows.append(dict(base, set=mode, leg=c[0], delta=round(abs(c[3]), 2), buy_minute=w[2], buy_price=round(w[0], 4),
                             exit_day="t", exit_minute=w[3], exit_price=round(w[1], 4), half_minute="", half_price=""))
            paths[c[0]] = False
    else:
        C.update(dte_min=1, dte_max=5, delta=DELTA)
        got, why = sim.pick(sym, date, ct, right, spot)
        if got is None or got[1] != CAL[CAL.index(date) + 1]: return None
        for name, run50 in ONE_D:
            w = L1.walk(sym, date, ct, right, got[0], spot, u, None if run50 is None else "all", run50)
            if not w: continue
            info = w[3]
            rows.append(dict(base, set=name, leg=got[0], delta=round(abs(got[3]), 2), buy_minute=info["b"], buy_price=round(w[0], 4),
                             exit_day=info["d"], exit_minute=info["m"], exit_price=round(w[1], 4),
                             half_minute=info.get("half_m") or "", half_price=round(info["half"], 4) if info.get("half") else ""))
            paths[got[0]] = paths.get(got[0], False) or info["d"] == "n"
    if not rows: return None
    P_ = {c: path_rows(sym, date, c, n) for c, n in paths.items()}
    return rows, P_


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    out, lst = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    ent = [e for e in entries() if lo <= e[0] <= hi]
    print(len(ent), "first alerts", flush=True)
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], right="C", r=r) for e, r in zip(ent, res) if r]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    keep = sorted((t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)), key=lambda t: (t["date"], t["minute"]))
    T, PT = [], []
    for t in keep:
        trs, ps = t["r"]
        for tr in trs:
            pid = f"{lst}|{tr['date']}|{tr['sym']}|{tr['leg']}"
            T.append(dict(key=f"{tr['set']}|{pid}", list=lst, pid=pid, **tr))
        for c, pr in ps.items():
            pid = f"{lst}|{t['date']}|{t['sym']}|{c}"
            PT.extend(dict(pid=pid, **p) for p in pr)
    for name, data in ((f"trades_{lst}", T), (f"paths_{lst}", PT)):
        with open(f"{out}/{name}.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0])); w.writeheader(); w.writerows(data)
        print(name, len(data), "rows", flush=True)
    for s in ("plain", "cheap", "liquid", "both", "d1", "b1", "b1f", "b1hc"): print(s, sum(r["set"] == s for r in T))


if __name__ == "__main__":
    main()
