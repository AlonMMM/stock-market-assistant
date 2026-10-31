"""The D2 entries and the 200-contract floor (the user, 2026-10-25: "1. if there is D2 involved buy even if there are
less then 200 contracts; 2. if it's D2 and fail on liquidity - try again after 5 minutes if the rules still mark
going in"). Bot 2.5 (the D2 bonus entry c12_15, the rest-stop champion's exits, no failed break). A D2 entry is one
that came in through the bonus (t < 1.8, so t >= 1.2 and D2 >= 1.5); the t >= 1.8 entries keep the floor. Set before
running:
  nofloor   a D2 entry whose 0.15-delta contract has under 200 contracts in the last 30 minutes buys it anyway (it
            still costs $0.20 or more and has a bar in the last 10 minutes); the fill is the simulator's usual one
  retry1    a D2 entry that fails the floor tries again once, 5 minutes later, if c12_15 still holds on the same side
            at that minute (volume >= 1.5x and t >= 1.8, or t >= 1.2 and D2 >= 1.5); the contract picked afresh then
  retry     the same, every 5 minutes, until a contract passes or the rule stops holding (or 15:44)
  retryday  every 5 minutes to 15:44, skipping a check where the rule does not hold (it sits at its threshold and
            often fails at exactly +5); the first check where it holds and a contract passes buys
and each again on the cheap fallback (cheap_up.py: under $0.20, the nearest-the-money strike at $0.20 or more), the
best 2.5 pick at the same risk. Fair list (and the 151 unseen, for the record). 1% / 2% from $100,000 with the 10%
overnight cap at each size.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs d2_liquid.py      (from the repo root)
"""
import collections, csv, glob, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import news_filter as nf
import defence_signals as ds
from store import calendar, day
from signals import series, beta
from levels import ctx
from low_delta import HIS40, PRIOR
from score_sum import account, held
from d2_failed_break import CHAMP

B = "data/local/x/bt"
CAL = calendar()
IDX = {d: i for i, d in enumerate(CAL)}
C = sim.C
RULE = ds.RULES["c12_15"]
MODES = ("plain", "nofloor", "retry1", "retry", "retryday", "cheap", "cheap+nofloor", "cheap+retry", "cheap+retryday")


def holds(sym, date, right):
    """-> {minute: True} where c12_15 holds on `right` (defence_signals.stock's own per-minute state, one day)."""
    i = IDX[date]
    bars = day(sym, date)
    b_ = beta(sym, date, i, CAL)
    cx = ctx(sym, date)
    if not bars or b_ is None or not cx or not cx["sd"]: return {}
    unit = cx["sd"]
    hist = []
    for d in CAL[i - 20:i]:
        v = [0] * 390
        for x in day(sym, d): v[x[0]] = x[5]
        acc, cum = 0, []
        for x in v: acc += x; cum.append(acc)
        if cum[-1] > 0: hist.append(cum)
    c = series(bars)[0]; spy = series(day("SPY", date))[0]
    vol = [0] * 390
    for x in bars: vol[x[0]] = x[5]
    cum, acc = [], 0
    for x in vol: acc += x; cum.append(acc)
    n = s1 = s2 = 0.0
    win = collections.deque(); dsum = [0.0, 0.0, 0.0, 0.0]
    out = {}
    for m in range(1, ds.LAST + 1):
        dc = dp = ec = ep = 0.0
        if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            rs = c[m] / c[m - 1] - 1; rp = spy[m] / spy[m - 1] - 1
            x = rs - b_ * rp
            n += 1; s1 += x; s2 += x * x
            if rp < 0:
                ec = x / unit
                if rs >= 0: dc = -b_ * rp / unit
            if rp > 0:
                ep = -x / unit
                if rs <= 0: dp = b_ * rp / unit
        win.append((dc, dp, ec, ep))
        for j, v in enumerate((dc, dp, ec, ep)): dsum[j] += v
        if len(win) > ds.WINDOW:
            old = win.popleft()
            for j, v in enumerate(old): dsum[j] -= v
        if m < ds.FIRST or n < ds.MIN_STEPS or c[m] is None: continue
        mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
        t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
        med = sorted(h[m] for h in hist); k = len(med) // 2
        usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
        rv = cum[m] / usual if usual else 0.0
        ok = ds.passes(RULE, t, rv, dsum[0], dsum[2]) if right == "C" else ds.passes(RULE, -t, rv, dsum[1], dsum[3])
        if ok: out[m] = c[m]
    return out


def pick_at(t, minute, spot, cheap, floor=True):
    cands = cu.candidates(t["sym"], t["date"], minute, t["right"], spot)
    c, why = cu.choose(cands, "cheap" if cheap else "plain")
    if c or why != "illiquid" or floor: return c, why
    best = min(cands, key=lambda x: abs(x[3] - C["delta"]))
    if cheap and best[4] < C["min_price"]:
        best = min((x for x in cands if x[4] >= C["min_price"] and abs(x[3]) >= abs(best[3])), key=lambda x: x[4])
    return best, None  # under the floor, bought anyway


def one(t):
    minute, spot = int(t["minute"]), float(t["price"])
    d2 = float(t["c_t"]) < 1.8
    first = {}
    for cheap in (False, True):
        first[cheap] = (t["contract"], t["expiry"], None) if t["status"] == "ok" else None
        if not first[cheap] and t["status"] in ("too_cheap", "illiquid"):
            c, why = pick_at(t, minute, spot, cheap)
            first[cheap] = (c[0], c[1], None) if c else why
    hold = None
    out, at = {}, {}
    for mode in MODES:
        cheap = mode.startswith("cheap")
        p, m = first[cheap], minute
        if not isinstance(p, tuple) and p == "illiquid" and d2:
            if mode.endswith("nofloor"):
                c, _ = pick_at(t, minute, spot, cheap, floor=False)
                p = (c[0], c[1], None) if c else None
            elif "retry" in mode:
                if hold is None: hold = holds(t["sym"], t["date"], t["right"])
                whole_day = mode.endswith("retryday")
                m2 = minute + 5
                while m2 <= ds.LAST:
                    if m2 not in hold:
                        if not whole_day: break
                        m2 += 5; continue
                    c, why = pick_at(t, m2, hold[m2], cheap)
                    if c: p, m = (c[0], c[1], None), m2; break
                    if why != "illiquid" or mode == "retry1": break
                    m2 += 5
        if not isinstance(p, tuple): continue
        sim.X.clear(); sim.X.update(CHAMP)
        cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], p[0], p[1], CAL)
        if cost is None: continue
        out[mode] = (sim.result(cost, steps, 0.01), sim.result(cost, steps, 0.02))
        out[mode + "#h"] = held(cost, steps)
        at[mode] = m
    return (t["date"], t["sym"], t["minute"]), out, at


def main():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: res = pool.map(one, T, chunksize=8)
    R = {k: v for k, v, _ in res}; AT = {k: a for k, _, a in res}
    key = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t)]
        d2i = [t for t in L if float(t["c_t"]) < 1.8 and t["status"] == "illiquid"]
        print(f"\n### {lname}: {len(L)} signals, {len(d2i)} D2 entries illiquid\n")
        print("| Pick | Trades | Winners | Per trade at $10K | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Added: n, winners, sum, without their best 5 | Best added |\n|---|---|---|---|---|---|---|---|---|---|")
        for mode in MODES:
            base = "cheap" if mode.startswith("cheap") else "plain"
            rows = [dict(date=t["date"], pnl=str(pt(R[key(t)][mode][0])), t=t, **R[key(t)][mode + "#h"]) for t in L if mode in R[key(t)]]
            a1, d1 = account(rows)
            a2, d2 = account([dict(date=t["date"], pnl=str(pt(R[key(t)][mode][1])), **R[key(t)][mode + "#h"]) for t in L if mode in R[key(t)]], 0.02)
            top = set(sorted(range(len(rows)), key=lambda i: -float(rows[i]["pnl"]))[:5])
            a5, _ = account([r for i, r in enumerate(rows) if i not in top])
            yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            per = sum(float(r["pnl"]) for r in rows) / len(rows)
            add = sorted(((float(r["pnl"]), r["t"]) for r in rows if mode != base and base not in R[key(r["t"])]), key=lambda a: -a[0])
            added = best = ""
            if add:
                added = f"{len(add)}, {sum(a[0] > 0 for a in add)}, {sum(a[0] for a in add) / 1e3:+,.0f}K, {sum(a[0] for a in add[5:]) / 1e3:+,.0f}K"
                best = ", ".join(f"{t['sym']} {t['date'][2:]} {x / 1e3:+,.0f}K" + (f" (+{AT[key(t)][mode] - int(t['minute'])}m)" if AT[key(t)][mode] != int(t["minute"]) else "") for x, t in add[:4])
            print(f"| {mode} | {len(rows)} | {sum(float(r['pnl']) > 0 for r in rows)} | {per:+,.0f} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {added} | {best} |", flush=True)
        waits = collections.Counter(AT[key(t)]["retryday"] - int(t["minute"]) for t in d2i if "retryday" in AT[key(t)])
        print(f"\nretryday: bought after {sorted(waits.items())[:20]} minutes (minutes: count)")


if __name__ == "__main__":
    main()
