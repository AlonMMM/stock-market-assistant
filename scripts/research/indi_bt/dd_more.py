"""More ways to cut the drop (the user, 2026-10-25: "try 2 and 3 with and without pyramid (add more if in the good
direction); also 6% stop for day"). Two bots, both 2.5 + cheap + the next strike for D2 with both fallbacks' trades at
half size: without the pyramid ($1,203,541 / 11%) and with it ($1,667,924 / 12%; d2_scale.py). Set before running:
  dte1-half     a contract that expires on the next session or the same day at half size (it moves most per stock move)
  vol-half      half size on a day when SPY's 20-session realized volatility (daily closes, to the day before) is in the
                top fifth of its past 250 sessions
  sma-half      half size on a day after SPY closed below its 20-session average
  day-stop 6%   no new entry (nor add) once the day's positions bought that day are down 6% of the account at the
                day's start, marked at their last option close and their sales so far (carried positions not counted)
Fair list, Feb 2024 - Oct 2026, from $100,000; the yardstick is the bot at a smaller flat size with the same drop.

  node --env-file=.env <dir>/run.mjs dd_more.py      (from the repo root)
"""
import bisect, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import d2_scale as ds
import sizing_sweep as sw
from store import day

CAL = eb.CAL
IDX = {d: i for i, d in enumerate(CAL)}


def spy_regime():
    """day -> (vol in the top fifth of the past 250 sessions, the close before below its 20-session average), from the day before."""
    closes = {}
    for d in CAL:
        b = day("SPY", d)
        if b: closes[d] = b[-1][4]
    days = [d for d in CAL if d in closes]
    rets = [None] + [closes[days[i]] / closes[days[i - 1]] - 1 for i in range(1, len(days))]
    vol = {}
    for i in range(21, len(days)): vol[days[i]] = st.pstdev(rets[i - 20:i])  # the 20 returns before day i
    out = {}
    for i, d in enumerate(days):
        if i < 271: continue
        past = sorted(vol[x] for x in days[i - 250:i] if x in vol)
        hi = vol.get(d) is not None and vol[d] >= past[int(0.8 * len(past))]
        sma = sum(closes[x] for x in days[i - 20:i]) / 20
        out[d] = (hi, closes[days[i - 1]] < sma)
    return out


def dte(leg):
    occ = leg["contract"]; k = len(occ) - 15
    exp = f"20{occ[k:k + 2]}-{occ[k + 2:k + 4]}-{occ[k + 4:k + 6]}"
    return IDX.get(exp, 10 ** 6) - IDX[leg["date"]] if exp in IDX else 9


def mark(leg, m):
    """The leg's gain over its cost at minute m of its entry day: sales so far plus what is held at the last close."""
    proceeds = sum(s[3] * s[4] for s in leg["steps"] if s[2] == "sell" and s[0] == leg["date"] and s[1] <= m)
    held = 1 - sum(s[3] for s in leg["steps"] if s[2] == "sell" and s[0] == leg["date"] and s[1] <= m)
    bars = [b for b in day(leg["contract"], leg["date"]) if b[0] <= m]
    last = bars[-1][4] if bars else leg["cost"]
    return (proceeds + held * last) / leg["cost"] - 1


_ret = {}


def ret_at(leg, pct):
    """The leg's return with the overnight cap at its own size (sim.result)."""
    k = (id(leg), round(pct, 5))
    if k not in _ret: _ret[k] = sim.result(leg["cost"], leg["steps"], pct)
    return _ret[k]


def positions(first, adds, pyramid):
    """-> [(date, minute, base size, leg)]: both fallbacks' trades at half; with the pyramid the add (held and up)."""
    out = []
    for k, a in first.items():
        out.append((a["date"], int(a["minute"]), 0.5 if a["added"] == 1 else 1.0, a))
        if pyramid and a["c_t"] < 1.8:
            b = adds.get(k)
            if b and int(b["minute"]) > int(a["minute"]):
                share, up = ds.held_at(a, int(b["minute"]))
                if share > 0 and up is not None and up > 0: out.append((b["date"], int(b["minute"]), 0.5, b))
    return sorted(out, key=lambda x: (x[0], x[1]))


def run(P, rule, reg, pct=0.01, flat=1.0):
    eq, peak, dd, cur, start, today, taken = 1e5, 1e5, 0.0, None, 1e5, [], 0
    pnl = 0.0
    for d, m, size, leg in P:
        if d != cur:
            eq += pnl; pnl = 0.0
            peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
            cur, start, today = d, eq, []
        s = size * flat
        if rule == "dte1-half" and dte(leg) <= 1: s *= 0.5
        if rule == "vol-half" and reg.get(d, (False, False))[0]: s *= 0.5
        if rule == "sma-half" and reg.get(d, (False, False))[1]: s *= 0.5
        if rule == "day-stop 6%" and sum(z * pct * start * mark(l, m) for z, l in today) <= -0.06 * start: continue
        r = ret_at(leg, s * pct)
        pnl += s * pct * start * max(-1, r)
        today.append((s, leg)); taken += 1
    eq += pnl; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
    return eq, dd, taken


def main():
    cand, reg_t = ds.load("sg_c12_15"), ds.load("s_t18r15")
    with mp.Pool(6) as pool:
        R = [r for r in pool.map(ds.legs, [(ds.BASE, t) for t in cand] + [("leg2", t) for t in reg_t], chunksize=8) if r]
    first = {k: v for s, k, v in R if s == ds.BASE}
    adds = {k: v for s, k, v in R if s == "leg2"}
    reg = spy_regime()
    print(f"days with SPY volatility in the top fifth: {sum(v[0] for v in reg.values())} of {len(reg)}; after a close under the 20-day average: {sum(v[1] for v in reg.values())}")
    for pyramid in (False, True):
        P = positions(first, adds, pyramid)
        print(f"\n### {'with' if pyramid else 'without'} the pyramid: {len(P)} positions\n")
        for pct in (0.01, 0.02):
            flat = [(run(P, None, reg, pct, f)[1], run(P, None, reg, pct, f)[0]) for f in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)]
            print(f"| At {pct:.0%} | Positions taken | Account | Worst drop | Flat size with the same drop | Edge over flat |\n|---|---|---|---|---|---|")
            for rule in (None, "dte1-half", "vol-half", "sma-half", "day-stop 6%"):
                e, d, n = run(P, rule, reg, pct)
                f = sw.edge(flat, d, e)
                print(f"| {rule or 'base'} | {n} | ${e:,.0f} | {d:.0%} | {'$%s' % format(round(f), ',') if f else 'beyond flat'} | {f'{e / f - 1:+.0%}' if f else ''} |", flush=True)
            print()


if __name__ == "__main__":
    main()
