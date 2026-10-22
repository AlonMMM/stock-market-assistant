"""V2: on the carried days, cut what is left once the stock's own move fades: its strength vs SPY x beta since that
day's open turns weak and its volume falls. Checked each minute from 10:00 New York (after the morning sale) to the
15:50 rule; on a trigger the rest is sold at the next 1-minute bar (middle - 2%). The champion's carried trades
(t >= 1.8, news filter, delta 0.15) walked again with its exits; the other trades keep their result.

  t      the day's t-stat of 1-minute moves vs SPY x beta since the open, in the bet's direction
  rvol   the day's volume since the open vs the median of the 20 sessions before, at the same minute
  r1     the same rvol on the trade's entry day, at the same minute

  python3 night_fade.py      (from the repo root)
"""
import csv, glob, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from signals import series, beta
from tiers_round import H, NIGHT
import news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = calendar(); IX = {d: i for i, d in enumerate(CAL)}
sim.X.update(dict(H, **NIGHT))
SH = sim.SH
RULES = {
    "A: t < 0 and volume under normal": lambda t, rv, r1: t < 0 and rv < 1.0,
    "B: t < 0 and volume under half of day 1's": lambda t, rv, r1: t < 0 and rv < 0.5 * r1,
    "C: t < -1": lambda t, rv, r1: t < -1,
    "D: t < 0.5 and volume under normal": lambda t, rv, r1: t < 0.5 and rv < 1.0,
    "E: t < 1 and volume under half of day 1's": lambda t, rv, r1: t < 1 and rv < 0.5 * r1,
}
FROM = 30  # 10:00 New York


def curves(sym, d):
    """t-stat (bet up) and rvol for minutes 0..389 of day d."""
    i = IX[d]; b_ = beta(sym, d, i, CAL)
    c, _, _, v = series(day(sym, d)); spy = series(day("SPY", d))[0]
    hist = []
    for p in CAL[i - 20:i]:
        vv = series(day(sym, p))[3]; acc, cum = 0, []
        for x in vv: acc += x; cum.append(acc)
        if cum[-1] > 0: hist.append(cum)
    T, R = [None] * 390, [None] * 390
    if b_ is None or len(hist) < 10: return T, R
    n = s1 = s2 = 0.0; acc = 0
    for m in range(390):
        acc += v[m]
        if m and c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            x = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1); n += 1; s1 += x; s2 += x * x
        if n >= 10:
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            T[m] = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
        usual = st.median(h[m] for h in hist)
        R[m] = acc / usual if usual else None
    return T, R


def run(t):
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
    if cost is None: return None
    base = sim.result(cost, steps)
    bet = 1 if t["right"] == "C" else -1
    carried = sorted({s[0] for s in steps if s[0] > t["date"]})
    out = dict(key=(t["date"], t["sym"], t["minute"]), base=base)
    if not carried: return out
    R1 = curves(t["sym"], t["date"])[1]
    C = {d: curves(t["sym"], d) for d in carried}
    O = {d: {b[0]: b for b in day(t["contract"], d)} for d in carried}
    for name, rule in RULES.items():
        got, rem, done = 0.0, 1.0, False
        for s in steps:  # keep every sale up to the trigger
            if s[2] != "sell": continue
            if done: break
            d, m = s[0], s[1]
            if d > t["date"]:  # look for a trigger on carried days before this sale
                T, Rv = C[d]
                for d2 in [x for x in carried if x <= d]:
                    T2, R2 = C[d2]
                    lo = FROM; hi = m if d2 == d else 380
                    for mm in range(lo, min(hi, 380)):
                        if T2[mm] is None or R2[mm] is None or R1[mm] is None: continue
                        if rule(bet * T2[mm], R2[mm], R1[mm]):
                            nxt = next((O[d2][k] for k in range(mm + 1, 390) if k in O[d2]), None)
                            if nxt is None: continue
                            got += rem * max((nxt[2] + nxt[3]) / 2 * (1 - SH), 0.01); rem = 0; done = True
                            out.setdefault("cut", {})[name] = (d2, mm)
                            break
                    if done: break
            if done: break
            got += s[3] * s[4]; rem -= s[3]
        out[name] = got / cost - 1 if done else base
    return out


def main():
    T = sorted((t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
               key=lambda t: (t["date"], int(t["minute"])))
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    with mp.Pool(6) as pool: R = {r["key"]: r for r in pool.map(run, T, chunksize=10) if r}
    lists = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)]
    for lname, lf in lists:
        L = [t for t in T if lf(t) and (t["date"], t["sym"], t["minute"]) in R]
        print(f"\n### {lname}: {len(L)} trades, {sum('cut' in R[(t['date'], t['sym'], t['minute'])] or len(R[(t['date'], t['sym'], t['minute'])]) > 2 for t in L)} carried\n")
        print("| Version | Cut early | Carried trades, $ (base -> new) | 2024 / 2025 / 2026 per trade | At 1% | At 2% |\n|---|---|---|---|---|---|")
        for name in ["champion"] + list(RULES):
            rows, cuts, cb, cn = [], 0, 0.0, 0.0
            for t in L:
                r = R[(t["date"], t["sym"], t["minute"])]
                if abs(r["base"] - float(t["pnl"]) / 1e4) > 0.01: print("differs", t["date"], t["sym"], r["base"], t["pnl"])
                v = r["base"] if name == "champion" else r.get(name, r["base"])
                if name in r.get("cut", {}): cuts += 1
                if len(r) > 2: cb += r["base"]; cn += v
                rows.append(dict(t, pnl=str(1e4 * max(-1, v))))
            yr = [[float(x["pnl"]) for x in rows if x["date"][:4] == y] for y in ("2024", "2025", "2026")]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            print(f"| {name} | {cuts} | {cb * 1e4:+,.0f} -> {cn * 1e4:+,.0f} | " + " / ".join(f"{st.fmean(v):+,.0f}" for v in yr)
                  + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |")
    with open(f"{B}/night_fade_cuts.csv", "w") as f:
        w = csv.writer(f); w.writerow(["date", "sym", "minute", "base"] + list(RULES) + ["cuts"])
        for k, r in R.items():
            if "cut" in r: w.writerow(list(k) + [round(r["base"], 4)] + [round(r.get(n, r["base"]), 4) for n in RULES] + [r["cut"]])


if __name__ == "__main__":
    main()
