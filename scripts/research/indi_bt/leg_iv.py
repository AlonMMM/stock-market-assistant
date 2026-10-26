"""The Alert leg (0DTE + 1DTE days out by 15:30, delta 0.35, the live rule since PR #151), sized by the leg's implied
volatility at the buy (the user, 2026-10-26: "if the IV is higher than 70% use regular size, if it's lower double it").
IV = the picker's own (iv_delta on the leg's last close at the side minute). Accounts from $100,000, whole contracts
from each morning's account, ±2% fill (±4% as a check):
  flat 1%                        the bot today
  IV >= cut: 1%, under: 2%       the user's rule, cut 50 / 60 / 70 / 80 / 100%
  the reverse                    IV >= 70%: 2%, under: 1% (a check that the side matters, not only the size)
  flat at the same average size  the user's rule's average share, on every trade (the fair benchmark)
Also the trades by IV band: count, winners, mean return on the premium.

  BT_UNIVERSE=wide node --env-file=.env <path>/run.mjs leg_iv.py
  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node ... leg_iv.py
"""
import multiprocessing as mp, os, sys, statistics as st
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
K, WAIT, DELTA, COMM = 0.25, 60, 0.35, 0.62


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
    if kind == "0": C.update(dte_min=0, dte_max=0, delta=DELTA)
    else: C.update(dte_min=1, dte_max=5, delta=DELTA)
    got, why = sim.pick(sym, date, ct, right, spot)
    if got is None: return None
    if kind == "1" and got[1] != CAL[CAL.index(date) + 1]: return None
    w = LF.walk(sym, date, ct, right, got[0], spot, u)
    if not w: return None
    return dict(buy=w[0], sell=w[1], iv=got[6], kind=kind)


def account(T, size_of, fill=2):
    eq, cur, start, rows = 1e5, None, 1e5, []
    for t in sorted(T, key=lambda t: (t["date"], t["minute"])):
        if t["date"] != cur: cur, start = t["date"], eq
        buy = t["buy"] if fill == 2 else t["buy"] / 1.02 * 1.04
        sell = t["sell"] if fill == 2 else t["sell"] / 0.98 * 0.96
        sz = size_of(t)
        q = int(sz / 100 * start // (buy * 100))
        if q < 1: continue
        pnl = q * (sell - buy) * 100 - COMM * 2 * q
        eq += pnl; rows.append(dict(t, pnl=pnl, account=eq, sz=sz))
    peak, dd = 1e5, 0.0
    for r in rows: peak = max(peak, r["account"]); dd = max(dd, 1 - r["account"] / peak)
    return eq, dd, rows


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    ent = [e for e in entries() if lo <= e[0] <= hi]
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], right="C", r=r) for e, r in zip(ent, res) if r]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    T = [dict(date=t["date"], minute=t["minute"], sym=t["sym"], **t["r"]) for t in rows
         if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)]
    ivs = sorted(t["iv"] for t in T)
    print(f"{len(T)} trades; leg IV median {st.median(ivs):.0%}, 25th {ivs[len(ivs) // 4]:.0%}, 75th {ivs[3 * len(ivs) // 4]:.0%}; "
          f"0DTE median {st.median(t['iv'] for t in T if t['kind'] == '0'):.0%}, 1DTE median {st.median(t['iv'] for t in T if t['kind'] == '1'):.0%}")
    print("\n| IV band | Trades | Winners | Mean return on premium | Median |\n|---|---|---|---|---|")
    bands = [(0, 0.4), (0.4, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 1.0), (1.0, 1.5), (1.5, 99)]
    for a, b in bands:
        R = [t["sell"] / t["buy"] - 1 for t in T if a <= t["iv"] < b]
        if R: print(f"| {a:.0%}-{'' if b > 50 else f'{b:.0%}'} | {len(R)} | {100 * sum(r > 0 for r in R) / len(R):.0f}% | {st.fmean(R):+.1%} | {st.median(R):+.1%} |")

    def line(lab, size_of):
        e1, d1, R = account(T, size_of)
        top = {(r["date"], r["sym"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
        e5, _, _ = account([t for t in T if (t["date"], t["sym"]) not in top], size_of)
        e4, d4, _ = account(T, size_of, 4)
        yrs = {}
        for r in R: yrs[r["date"][:4]] = yrs.get(r["date"][:4], 0) + r["pnl"]
        avg = st.fmean(r["sz"] for r in R)
        print(f"| {lab} | {len(R)} | {avg:.2f}% | ${e1:,.0f}, {100 * d1:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% | " + ", ".join(f"{y} {v:+,.0f}" for y, v in sorted(yrs.items())) + " |")
        return avg

    print("\n| Size | Trades | Average size | 1%-based, ±2%: end, worst drop | without best 5 | ±4% | by year |\n|---|---|---|---|---|---|---|")
    line("flat 1% (the bot today)", lambda t: 1)
    line("flat 2%", lambda t: 2)
    avgs = {}
    for cut in (0.5, 0.6, 0.7, 0.8, 1.0):
        avgs[cut] = line(f"IV ≥ {cut:.0%}: 1%, under: 2%", lambda t, c=cut: 1 if t["iv"] >= c else 2)
    line("reverse: IV ≥ 70%: 2%, under: 1%", lambda t: 2 if t["iv"] >= 0.7 else 1)
    a = round(avgs[0.7] * 2) / 2 if False else avgs[0.7]
    line(f"flat {a:.2f}% (the 70% rule's average)", lambda t: a)


if __name__ == "__main__":
    main()
