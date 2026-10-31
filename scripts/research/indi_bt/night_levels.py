"""V2: the overnight hold with support / resistance, and a stock hedge on the held winners (the user, 2026-10-24).
On the chosen bot (the champion + the failed-break sale), the fair list and the 151 unseen. Set before running:

1. Levels at the 15:50 decision on the entry day (levels.py: yesterday's / the 5-day / the first 15 minutes' high or
   low, S30 units; for a call the highs, for a put the lows):
     above support  the stock is 0.25 S30 or more past a level it opened short of (broke it today and holds it)
     stuck          in the last hour (14:50-15:50) it came within 0.25 S30 of a level ahead (one of those, or the
                    day's high / low made before 14:50) and is now 0.5 S30 or more back from it, never 0.25 past
   Versions of the hold (the champion holds at +100%):
     R1  no hold when stuck
     R2  hold only when above support
     R3  also hold from +50% when above support and not stuck
     R4  R1 + R3
     R5  control (added after the first run: "above support" was true for every held trade): hold from +50%, no levels
     R6  hold from +50% unless stuck
2. The hedge on the first night held: at 15:50, short (call) / buy (put) contracts x 100 x delta x 0.5 shares (delta
   from the option's 15:50 price), closed at the first sale of the next session at that minute's stock close; no
   stock costs counted. H50 is that; H100 hedges the full delta.
1% / 2% of the start-of-day account from $100,000.

  python3 night_levels.py      (from the repo root)
"""
import csv, glob, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import day, calendar, iv_delta, years_to_expiry
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account, held as booked
from levels import ctx, NEAR, BREAK, BACK

B = "data/local/x/bt"
CAL = calendar()
D = 380  # 15:50
X0 = {**sim.X, **H, **NIGHT, "failed_break": True}


def levels_now(t):
    """-> (above_support, stuck) at 15:50 of the entry day, or None."""
    x = ctx(t["sym"], t["date"])
    if x is None or x["c"][D] is None: return None
    bet = 1 if t["right"] == "C" else -1
    c, unit = x["c"], x["sd"] * x["c"][D]
    first = next((v for v in c if v), None)
    hi15 = max((v for v in x["h"][:15] if v), default=None); lo15 = min((v for v in x["l"][:15] if v), default=None)
    fixed = [x["prev_hi"], x["p5_hi"], hi15] if bet > 0 else [x["prev_lo"], x["p5_lo"], lo15]
    fixed = [v for v in fixed if v]
    above = any(bet * (first - v) < 0 and bet * (c[D] - v) >= BREAK * unit for v in fixed)
    early = [v for v in (x["h"] if bet > 0 else x["l"])[:D - 60] if v]
    ahead = fixed + ([max(early) if bet > 0 else min(early)] if early else [])
    stuck = False
    for v in ahead:
        if bet * (v - c[D]) <= 0: continue  # not ahead now
        last = [c[m] for m in range(D - 60, D + 1) if c[m]]
        touched = any(bet * (v - p) <= NEAR * unit for p in last)
        broke = any(bet * (p - v) >= BREAK * unit for p in last)
        if touched and not broke and bet * (v - c[D]) >= BACK * unit: stuck = True
    return above, stuck


def walk(t):
    out = dict(key=(t["date"], t["sym"], t["minute"]))
    for name, gain in (("base", 1.0), ("low", 0.5), ("none", 99)):
        sim.X.clear(); sim.X.update(X0); sim.X["carry_min_gain"] = gain
        cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
        if cost is None: return None
        out[name] = sim.result(cost, steps)
        out[name + "#h"] = booked(cost, steps)
        if name == "base": out["cost"], out["steps"] = cost, steps
    out["lv"] = levels_now(t)
    out["hedge"] = hedge(t, out["cost"], out["steps"])
    return out


def hedge(t, cost, steps):
    """-> the hedge's return on the premium per unit of the delta hedged (x 0.5 for H50), or 0 when nothing was held."""
    carry = next((s for s in steps if s[2] == "carry"), None)
    if not carry: return 0.0
    bet = 1 if t["right"] == "C" else -1
    d0 = carry[0]
    s0 = next((b[4] for b in reversed(day(t["sym"], d0)) if b[0] <= D), None)
    o = carry[4]
    k = float(t["contract"][-8:]) / 1000
    x = iv_delta(o, s0, k, years_to_expiry(d0, D, t["expiry"]), sim.C["rate"], t["right"] == "C") if s0 else None
    if x is None: return 0.0
    delta = x[1]
    nxt = next((s for s in steps if s[2] == "sell" and s[0] > d0), None)
    if not nxt: return 0.0
    s1 = next((b[4] for b in reversed(day(t["sym"], nxt[0])) if b[0] <= nxt[1]), None)
    if s1 is None: return 0.0
    return -bet * delta * carry[3] * (s1 - s0) / cost  # shares = rem x 100 x delta per contract, premium = 100 x cost


def pick(r, rule):
    lv = r["lv"]
    if rule == "R5": return r["low"]
    if lv is None or rule == "champion": return r["base"]
    above, stuck = lv
    held = any(s[2] == "carry" for s in r["steps"])
    if rule == "R1": return r["none"] if held and stuck else r["base"]
    if rule == "R2": return r["base"] if above else r["none"]
    low_ok = above and not stuck
    if rule == "R3": return r["low"] if low_ok else r["base"]
    if rule == "R4":
        if held and stuck: return r["none"]
        return r["low"] if low_ok else r["base"]
    if rule == "R5": return r["low"]  # control: hold from +50%, no levels
    if rule == "R6": return r["base"] if stuck else r["low"]  # hold from +50% unless stuck


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(8) as pool: R = {r["key"]: r for r in pool.map(walk, T, chunksize=10) if r}
    key = lambda t: (t["date"], t["sym"], t["minute"])
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and key(t) in R]
        held = [t for t in L if any(s[2] == "carry" for s in R[key(t)]["steps"])]
        lv = [R[key(t)]["lv"] for t in held if R[key(t)]["lv"]]
        print(f"\n### {lname}: {len(L)} trades, {len(held)} held overnight; of those above support {sum(a for a, s in lv)}, stuck {sum(s for a, s in lv)}")
        print("| Version | Account at 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 (P&L at $10K) | Trades changed |\n|---|---|---|---|---|")
        versions = [("champion", None), ("R1", None), ("R2", None), ("R3", None), ("R4", None), ("R5", None), ("R6", None), ("champion", 0.5), ("champion", 1.0)]
        for rule, hg in versions:
            rows, changed = [], 0
            for t in L:
                r = R[key(t)]; v = pick(r, rule)
                walk_ = next(n for n in ("base", "low", "none") if r[n] == v)  # the walk v came from
                if hg: v = v + hg * r["hedge"]
                if abs(v - r["base"]) > 1e-9: changed += 1
                rows.append(dict(date=t["date"], pnl=str(1e4 * max(-1, v)), **r[walk_ + "#h"]))
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            yr = " / ".join(f"{sum(float(x['pnl']) for x in rows if x['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            name = rule if not hg else f"hedge {int(hg * 100)}% of delta"
            print(f"| {name} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | {changed} |", flush=True)
        worst = sorted((R[key(t)]["base"], R[key(t)]["base"] + 0.5 * R[key(t)]["hedge"], t["sym"], t["date"]) for t in held)[:5]
        print("worst held nights, without -> with the 50% hedge:", [(s, d, f"{100 * a:+.0f}% -> {100 * b:+.0f}%") for a, b, s, d in worst])


if __name__ == "__main__":
    main()
