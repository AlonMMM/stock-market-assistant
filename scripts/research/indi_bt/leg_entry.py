"""The Alert leg entering earlier (the user, 2026-10-26: "I just think we enter too late and can improve";
then "Also decrease the give up to 15 minutes"). The live rule
(0DTE + 1DTE by 15:30, 0.35, 200 contracts) with the side confirmed sooner:
  k = 0.05 / 0.10 / 0.15 / 0.20 / 0.25 (live) / 0.35   the stock's move from the alert price, in typical 30-minute moves
  now                                                  no wait: the alert's own direction, bought the minute after it
Give-up (no side within W minutes of the alert: no trade): 60 (live) and 15 for every k, also 10 / 30 at 0.25; a
shorter W only drops the trades whose side came later. Also: the stock's move from the alert to the buy and to the sale, in those units. 1%, ±2% (±4%), no
limits and the live ones.

  BT_UNIVERSE=wide node --env-file=.env <path>/run.mjs leg_entry.py
  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node ... leg_entry.py
"""
import multiprocessing as mp, os, sys, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from levels import ctx
import leg_fallback as LF
import leg_daycap as D
from leg_export import entries

CAL = calendar()
C = sim.C
WAIT, DELTA = 60, 0.35
KS = (0.05, 0.10, 0.15, 0.20, 0.25, 0.35, "now")


def one(sig):
    date, sym, m, kind, alert = sig
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if m not in sb or not x or not x.get("sd"): return None
    u, stock0 = x["sd"], sb[m][4]
    out = {}
    for k in KS:
        side = None
        if k == "now":
            if m + 1 in sb: side = (m + 1, "C" if alert == "up" else "P")
        else:
            for t in range(m + 1, m + WAIT + 1):
                if t in sb and abs(sb[t][4] / stock0 - 1) >= k * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
        if not side: continue
        ct, right = side; spot = sb[ct][4]
        if kind == "0": C.update(dte_min=0, dte_max=0, delta=DELTA)
        else: C.update(dte_min=1, dte_max=5, delta=DELTA)
        got, why = sim.pick(sym, date, ct, right, spot)
        if got is None: continue
        if kind == "1" and got[1] != CAL[CAL.index(date) + 1]: continue
        w = LF.walk(sym, date, ct, right, got[0], spot, u)
        if not w: continue
        sx = sb.get(w[3], sb.get(max(q for q in sb if q <= w[3])))[4]
        sgn = 1 if right == "C" else -1
        out[k] = dict(buy=w[0], sell=w[1], bm=w[2], xm=w[3], wait=ct - m, at_buy=sgn * (spot / stock0 - 1) / u, at_sell=sgn * (sx / stock0 - 1) / u,
                      agree=(alert == "up") == (right == "C"))
    return out


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    ent = [e for e in entries() if lo <= e[0] <= hi]
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], right="C", r=r) for e, r in zip(ent, res) if r]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)]
    print("\n| Side at | Give up | Trades | Winners | Wait (median min) | With the alert | Stock at the buy / at the sale (units) | ±2%: end, worst drop | without best 5 | ±4%: end, worst drop | live limits: end, worst drop |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    plan = [(k, w) for k in KS if k != "now" for w in ((10, 15, 30, 60) if k == 0.25 else (15, 60))] + [("now", 1)]
    for k, W in plan:
        T = [dict(date=t["date"], minute=t["minute"], sym=t["sym"], **t["r"][k]) for t in keep if k in t["r"] and t["r"][k]["wait"] <= W]
        e1, d1, R, wd, _ = D.account(T, 1, 2)
        top = {(r["date"], r["sym"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
        e5 = D.account([t for t in T if (t["date"], t["sym"]) not in top], 1, 2)[0]
        e4, d4, _, _, _ = D.account(T, 1, 4)
        eL, dL, _, _, _ = D.account(T, 1, 2, loss=5, max_trades=5, max_open=3)
        lab = "now (the alert's direction)" if k == "now" else f"{k:.2f}"
        live = " (live)" if (k, W) == (0.25, 60) else ""
        print(f"| {lab}{live} | {'—' if k == 'now' else f'{W} min'} | {len(R)} | {100 * sum(r['pnl'] > 0 for r in R) / len(R):.0f}% | {st.median(t['wait'] for t in T):.0f} | {100 * sum(t['agree'] for t in T) / len(T):.0f}% | "
              f"{st.median(t['at_buy'] for t in T):+.2f} / {st.median(t['at_sell'] for t in T):+.2f} | ${e1:,.0f}, {100 * d1:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% | ${eL:,.0f}, {100 * dL:.1f}% |")


if __name__ == "__main__":
    main()
