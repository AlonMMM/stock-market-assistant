"""The Alert leg trading a stock more than once a day (the user, 2026-10-26: "what if we can enter to stock twice,
even if option is open. And even if not (check both)"). The live rule (0DTE + 1DTE by 15:30, 0.35, 200 contracts,
the side at 0.25 S30 within 10 minutes, the 0.75 give-back). Every alert of the day from 09:40 to 13:00 is an event
when the minute before it had none (one burst = one event); each event runs the rule on its own:
  first   only the day's first event (the bot today)
  open    every event, even while the stock's earlier trade is open (the live bot would refuse the same contract
          while held; here a second unit of it is counted)
  flat    an event counts only when the stock has no open trade at its side minute (re-entry after a sale)
1%, ±2% (±4%), no limits and the live caps (5% day loss, 5 a day, 3 open).

  BT_UNIVERSE=wide node --env-file=.env <path>/run.mjs leg_twice.py
  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node ... leg_twice.py
"""
import multiprocessing as mp, os, sys, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar
from levels import ctx
from rvol_alert import alerts_for
from zero5 import SPAN, FIRST, LAST
import leg_1dte as L1
import leg_fallback as LF
import leg_daycap as D

CAL = calendar()
C = sim.C
K, WAIT, DELTA = 0.25, 10, 0.35


def days():
    out = []
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            k = L1.kind_of(sym, date)
            if k: out.append((date, sym, k))
    return out


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
    if kind == "0": C.update(dte_min=0, dte_max=0, delta=DELTA)
    else: C.update(dte_min=1, dte_max=5, delta=DELTA)
    trades = []
    for n, (m, side_al) in enumerate(ev):
        if m not in sb: continue
        stock0 = sb[m][4]; side = None
        for t in range(m + 1, m + WAIT + 1):
            if t in sb and abs(sb[t][4] / stock0 - 1) >= K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
        if not side: trades.append(dict(n=n, minute=m, trade=None)); continue
        ct, right = side; spot = sb[ct][4]
        got, why = sim.pick(sym, date, ct, right, spot)
        if got is None or (kind == "1" and got[1] != CAL[CAL.index(date) + 1]): trades.append(dict(n=n, minute=m, trade=None)); continue
        w = LF.walk(sym, date, ct, right, got[0], spot, u)
        trades.append(dict(n=n, minute=m, trade=dict(buy=w[0], sell=w[1], bm=w[2], xm=w[3], ct=ct, contract=got[0]) if w else None))
    return dict(first_minute=ev[0][0], events=trades)


def pick(r, how):
    evs = r["events"]
    if how == "first": return [e for e in evs[:1] if e["trade"]]
    if how == "open": return [e for e in evs if e["trade"]]
    out, busy_to = [], -1
    for e in evs:
        t = e["trade"]
        if not t: continue
        if t["ct"] <= busy_to: continue
        out.append(e); busy_to = t["xm"]
    return out


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    jobs = [j for j in days() if lo <= j[0] <= hi]
    with mp.Pool(8) as pool: res = pool.map(one, jobs, chunksize=4)
    rows = [dict(date=j[0], sym=j[1], minute=r["first_minute"], right="C", r=r) for j, r in zip(jobs, res) if r]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)]
    nev = [len(t["r"]["events"]) for t in keep]
    print(f"{len(keep)} stock-days with an alert; events a day: median {st.median(nev)}, 2+ on {sum(n > 1 for n in nev)}, 3+ on {sum(n > 2 for n in nev)}")
    print("\n| Entries | Trades | 2nd+ trades (their P&L at 1%) | Winners | ±2%: end, worst drop | without best 5 | ±4%: end, worst drop | live caps: end, worst drop |")
    print("|---|---|---|---|---|---|---|---|")
    dist = {}
    for how, lab in (("first", "first alert only (the bot today)"), ("flat", "again only when flat"), ("open", "again even while open")):
        T = []
        for t in keep:
            for e in pick(t["r"], how):
                T.append(dict(date=t["date"], sym=t["sym"], minute=e["minute"], again=e["n"] > 0, nth=len([x for x in T if x["date"] == t["date"] and x["sym"] == t["sym"]]) + 1, **{k: v for k, v in e["trade"].items() if k in ("buy", "sell", "bm", "xm")}))
        e1, d1, R, wd, _ = D.account(T, 1, 2)
        top = sorted(R, key=lambda r: -r["pnl"])[:5]
        e5 = D.account([t for t in T if not any(t["date"] == x["date"] and t["sym"] == x["sym"] and t["minute"] == x["minute"] for x in top)], 1, 2)[0]
        e4, d4, _, _, _ = D.account(T, 1, 4)
        eL, dL, _, _, _ = D.account(T, 1, 2, loss=5, max_trades=5, max_open=3)
        dist[lab] = (R, nev)
        ag = [r for r in R if r["again"]]
        print(f"| {lab} | {len(R)} | {len(ag)} ({sum(r['pnl'] for r in ag):+,.0f}, {100 * sum(r['pnl'] > 0 for r in ag) / max(1, len(ag)):.0f}% win) | {100 * sum(r['pnl'] > 0 for r in R) / len(R):.0f}% | "
              f"${e1:,.0f}, {100 * d1:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% | ${eL:,.0f}, {100 * dL:.1f}% |")

    # a cap per stock per day on "again when flat" (the user: "show max per day"), and the bot's trades a day
    print("\n| Max trades a stock a day (again when flat) | Trades | ±2%: end, worst drop | without best 5 | ±4%: end, worst drop | live caps: end, worst drop |\n|---|---|---|---|---|---|")
    for cap in (1, 2, 3, 4, 99):
        T = []
        for t in keep:
            for e in pick(t["r"], "flat")[:cap]:
                T.append(dict(date=t["date"], sym=t["sym"], minute=e["minute"], **{k: v for k, v in e["trade"].items() if k in ("buy", "sell", "bm", "xm")}))
        e1, d1, R, wd, _ = D.account(T, 1, 2)
        top = sorted(R, key=lambda r: -r["pnl"])[:5]
        e5 = D.account([t for t in T if not any(t["date"] == x["date"] and t["sym"] == x["sym"] and t["minute"] == x["minute"] for x in top)], 1, 2)[0]
        e4, d4, _, _, _ = D.account(T, 1, 4)
        eL, dL, _, _, _ = D.account(T, 1, 2, loss=5, max_trades=5, max_open=3)
        print(f"| {'no cap' if cap == 99 else cap} | {len(R)} | ${e1:,.0f}, {100 * d1:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% | ${eL:,.0f}, {100 * dL:.1f}% |")
    for lab in ("first alert only (the bot today)", "again only when flat"):
        R, _ = dist[lab]
        per = {}
        for r in R: per[r["date"]] = per.get(r["date"], 0) + 1
        bins = [(1, 1), (2, 2), (3, 3), (4, 5), (6, 8), (9, 99)]
        print(f"\n| The bot's trades a day, {lab} | " + " | ".join(f"{a}" if a == b else (f"{a}+" if b == 99 else f"{a}-{b}") for a, b in bins) + " |\n|---" * (len(bins) + 1) + "|")
        print("| days | " + " | ".join(str(sum(1 for v in per.values() if a <= v <= b)) for a, b in bins) + f" |  (days with a trade {len(per)}, most {max(per.values())} on {max(per, key=per.get)})")

    # the distributions (the user: "show me distribution of enters per stock")
    print("\n| Alert events on a stock-day | 1 | 2 | 3 | 4 | 5+ |\n|---|---|---|---|---|---|")
    c = [sum(1 for n in nev if (n == k if k < 5 else n >= 5)) for k in (1, 2, 3, 4, 5)]
    print("| stock-days | " + " | ".join(str(x) for x in c) + " |")
    for lab in ("again only when flat", "again even while open"):
        R, _ = dist[lab]
        per = {}
        for r in R: per[(r["date"], r["sym"])] = per.get((r["date"], r["sym"]), 0) + 1
        h = [sum(1 for v in per.values() if (v == k if k < 5 else v >= 5)) for k in (1, 2, 3, 4, 5)]
        print(f"\n#### {lab}\n\n| Trades on a stock-day | 1 | 2 | 3 | 4 | 5+ |\n|---|---|---|---|---|---|\n| stock-days | " + " | ".join(str(x) for x in h) + f" |  (most {max(per.values())})")
        print("\n| Entry | Trades | Winners | Avg P&L at 1% | Total |\n|---|---|---|---|---|")
        for k in (1, 2, 3, 4, 5):
            G = [r for r in R if (r["nth"] == k if k < 5 else r["nth"] >= 5)]
            if G: print(f"| {'5th+' if k == 5 else ['1st', '2nd', '3rd', '4th'][k - 1]} | {len(G)} | {100 * sum(r['pnl'] > 0 for r in G) / len(G):.0f}% | {st.fmean(r['pnl'] for r in G):+,.0f} | {sum(r['pnl'] for r in G):+,.0f} |")
        bys = {}
        for r in R: bys.setdefault(r["sym"], []).append(r)
        top = sorted(bys.items(), key=lambda kv: -sum(1 for r in kv[1] if r["nth"] > 1))[:10]
        print("\n| Stock | Trades | Of them re-entries | Stock-days | P&L of re-entries |\n|---|---|---|---|---|")
        for sym, G in top:
            ag = [r for r in G if r["nth"] > 1]
            print(f"| {sym} | {len(G)} | {len(ag)} | {len({r['date'] for r in G})} | {sum(r['pnl'] for r in ag):+,.0f} |")


if __name__ == "__main__":
    main()
