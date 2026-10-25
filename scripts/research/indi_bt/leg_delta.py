"""The Alert leg, 0DTE + 1DTE days out by 15:30, at other deltas (the user, 2026-10-25: "can we test other deltas now?
for the +1DTE to 15:30 strategy"). The rule as leg_export.py's plain + d1 sets (the leg picked at the side, $0.20 and
200 contracts, out on the 0.75 give-back or 15:30); only the target delta changes, on both kinds of day, and each kind
is also reported alone so the two can take different deltas.

  BT_UNIVERSE=wide node --env-file=.env <path>/run.mjs leg_delta.py
  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node ... leg_delta.py
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from levels import ctx
import leg_fallback as LF
from leg_export import entries

CAL = calendar()
C = sim.C
K, WAIT = 0.25, 60
DELTAS = (0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50)


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
    out = {}
    for d in DELTAS:
        if kind == "0": C.update(dte_min=0, dte_max=0, delta=d)
        else: C.update(dte_min=1, dte_max=5, delta=d)
        got, why = sim.pick(sym, date, ct, right, spot)
        if got is None: continue
        if kind == "1" and got[1] != CAL[CAL.index(date) + 1]: continue
        w = LF.walk(sym, date, ct, right, got[0], spot, u)
        if w: out[d] = dict(buy=w[0], sell=w[1], delta=abs(got[3]), price=got[4])
    return out


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    ent = [e for e in entries() if lo <= e[0] <= hi]
    print(len(ent), "first alerts", flush=True)
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], kind=e[3], right="C", r=r) for e, r in zip(ent, res) if r is not None]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)]
    pick = lambda d0, d1: [dict(date=t["date"], minute=t["minute"], sym=t["sym"], kind=t["kind"], **t["r"][d0 if t["kind"] == "0" else d1])
                           for t in keep if (d0 if t["kind"] == "0" else d1) in t["r"]]

    def line(lab, T):
        e1, d1_, R = LF.account(T, 1, 2)
        top = {(r["date"], r["sym"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
        e5, _, _ = LF.account([t for t in T if (t["date"], t["sym"]) not in top], 1, 2)
        e4, d4, _ = LF.account(T, 1, 4); e2, d2, _ = LF.account(T, 2, 2)
        yrs = {}
        for r in R: yrs[r["date"][:4]] = yrs.get(r["date"][:4], 0) + r["pnl"]
        p0 = sum(r["pnl"] for r in R if r["kind"] == "0"); p1 = sum(r["pnl"] for r in R if r["kind"] == "1")
        n0 = sum(r["kind"] == "0" for r in R); n1 = len(R) - n0
        print(f"| {lab} | {len(R)} | {100 * sum(r['pnl'] > 0 for r in R) / max(1, len(R)):.0f}% | ${e1:,.0f}, {100 * d1_:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% | ${e2:,.0f}, {100 * d2:.1f}% | "
              f"{p0:+,.0f} on {n0} / {p1:+,.0f} on {n1} | " + ", ".join(f"{y} {v:+,.0f}" for y, v in sorted(yrs.items())) + " |")

    print("\n| Delta (0DTE / 1DTE) | Trades | Winners | 1%, ±2%: end, worst drop | without best 5 | 1%, ±4% | 2%, ±2% | P&L 0DTE days / 1DTE days | by year |")
    print("|---|---|---|---|---|---|---|---|---|")
    for d in DELTAS: line(f"{d:.2f} / {d:.2f}", pick(d, d))
    # each kind's best delta by its own P&L at 1%, then together
    best = {}
    for kind in "01":
        sc = {}
        for d in DELTAS:
            R = LF.account([t for t in pick(d, d) if t["kind"] == kind], 1, 2)[2]
            sc[d] = sum(r["pnl"] for r in R)
        best[kind] = max(sc, key=sc.get)
        print(f"\n{'0DTE' if kind == '0' else '1DTE'} days alone, P&L at 1% by delta: " + ", ".join(f"{d:.2f} {v:+,.0f}" for d, v in sc.items()))
    print()
    line(f"mixed: {best['0']:.2f} / {best['1']:.2f}", pick(best["0"], best["1"]))
    import statistics as st
    for d in DELTAS:
        T = pick(d, d)
        for kind in "01":
            ps = [t["price"] for t in T if t["kind"] == kind]
            if ps: print(f"delta {d:.2f} {'0DTE' if kind == '0' else '1DTE'}: {len(ps)} legs, median price ${st.median(ps):.2f}, median real delta {st.median(t['delta'] for t in T if t['kind'] == kind):.2f}")


if __name__ == "__main__":
    main()
