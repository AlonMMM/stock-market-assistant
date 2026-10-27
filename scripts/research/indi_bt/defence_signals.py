"""The defence study (user, 2026-10-24: "holding against this kind of drop should give me a huge extra bonus").

D, the defence, at minute m: over the last 30 minutes, on every minute where SPY fell, if the stock did not fall,
beta x SPY's drop; summed and divided by the stock's unit S30 (levels.py: the spread of its 1-minute returns over the
5 sessions before x sqrt(30)). The market pull the stock shrugged off, in its own units. A put is the mirror:
SPY-up minutes where the stock did not rise. D2 adds the stock's excess move (stock minus beta x SPY) on every
SPY-down minute whether it held fully or not: the t-stat's numerator restricted to the bad minutes.

The same per-minute t and day volume ratio as the champion (tune_signals.py), 09:40-15:44, one signal per stock and
day, the first minute a rule holds in either direction. Rules:
  base        the champion's entry: t >= 1.8 and volume >= 1.5x
  dXX / eXX   replace t: D (D2) >= XX/10 and volume >= 1.5x        (D: 0.3 0.5 0.7 1; D2: 0.5 1 1.5 2)
  tdXX / teXX filter: the champion's entry and D (D2) >= XX/10
  bT_XX / cT_XX bonus: volume >= 1.5x and (t >= 1.8, or t >= T/10 and D (D2) >= XX/10)
  t12 / t15   controls: t >= 1.2 / 1.5 and volume >= 1.5x, no defence at all

  BT_UNIVERSE=wide python3 defence_signals.py      (from the repo root) -> data/local/x/bt/s_sig_<rule>_<year>.csv
"""
import collections, csv, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta
from levels import ctx

B = "data/local/x/bt"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
FIRST, LAST, MIN_STEPS, WINDOW = 10, 374, 10, 30
# The D2 window (the user, 2026-10-27: "can we go with D2 for the last 2 hours? except the 15 minutes of the openning..
# also try it with t>=0.8/0.6"): BT_D2_WINDOW minutes back (default 30); BT_D2_SKIP: minutes from the open that never
# count in it (default 0); BT_SIG_SUFFIX names the signal files of such a run (s_sig_<rule><suffix>_<year>.csv)
WINDOW = int(os.environ.get("BT_D2_WINDOW", WINDOW))
SKIP = int(os.environ.get("BT_D2_SKIP", 0))
SUFFIX = os.environ.get("BT_SIG_SUFFIX", "")
# Volume weights (the user, 2026-10-27: "gives more weight to a big size burst and also more weight on the against spy
# by volume"): BT_VWEIGHT "rel" weighs each minute by its volume / its usual volume for that minute (the median of the
# 20 sessions before), "sqrt" by the square root of that, capped at VW_CAP; BT_VW_PARTS "both" / "t" / "d2": where.
# The weighted t keeps the scale: weighted mean / weighted spread x sqrt(the weights' effective n).
VWEIGHT = os.environ.get("BT_VWEIGHT", "")
VW_PARTS = os.environ.get("BT_VW_PARTS", "both")
VW_CAP = 10.0
T_MIN, RV_MIN = 1.8, 1.5

# name -> (t floor or None, D floor or None, which D ("d" | "e"), bonus t floor or None)
RULES = {"base": (T_MIN, None, "d", None)}
# D (a defended drop in units) is rare above 1; D2 (the excess on the bad minutes) runs higher.
for x in (3, 5, 7, 10):
    RULES[f"d{x:02d}"] = (None, x / 10, "d", None)
    RULES[f"td{x:02d}"] = (T_MIN, x / 10, "d", None)
for x in (5, 10, 15, 20):
    RULES[f"e{x:02d}"] = (None, x / 10, "e", None)
    RULES[f"te{x:02d}"] = (T_MIN, x / 10, "e", None)
for lt in (6, 8, 10, 12, 15):
    for x in (3, 5, 7):
        RULES[f"b{lt}_{x:02d}"] = (T_MIN, x / 10, "d", lt / 10)
    for x in (10, 15, 20):
        RULES[f"c{lt}_{x}"] = (T_MIN, x / 10, "e", lt / 10)
# Controls for the bonus arm: the lower t alone, without any defence.
RULES["t12"] = (1.2, None, "d", None)
RULES["t15"] = (1.5, None, "d", None)
if os.environ.get("BT_RULES"): RULES = {k: RULES[k] for k in os.environ["BT_RULES"].split(",")}


def passes(rule, t, rv, d, e):
    tt, dx, which, bonus = rule
    if rv < RV_MIN: return False
    dv = d if which == "d" else e
    if bonus is not None: return t >= tt or (t >= bonus and dv >= dx)
    if tt is not None and t < tt: return False
    if dx is not None and dv < dx: return False
    return True


def stock(sym):
    cal = calendar(); out = {k: [] for k in RULES}
    for i, date in enumerate(cal):
        if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
        bars = day(sym, date)
        if len(bars) <= 300: continue
        b_ = beta(sym, date, i, cal)
        if b_ is None: continue
        cx = ctx(sym, date)
        if not cx or not cx["sd"]: continue
        unit = cx["sd"]  # S30 as a fraction of the price
        hist = []
        for d in cal[i - 20:i]:
            v = [0] * 390
            for x in day(sym, d): v[x[0]] = x[5]
            acc, cum = 0, []
            for x in v: acc += x; cum.append(acc)
            if cum[-1] > 0: hist.append(cum)
        if len(hist) < 10: continue
        c = series(bars)[0]; spy = series(day("SPY", date))[0]
        umin = [0.0] * 390   # the usual volume of each minute (the median over the 20 sessions before)
        if VWEIGHT:
            for mm in range(390):
                per = sorted(h[mm] - (h[mm - 1] if mm else 0) for h in hist)
                umin[mm] = per[len(per) // 2]
        vol = [0] * 390
        for x in bars: vol[x[0]] = x[5]
        cum, acc = [], 0
        for x in vol: acc += x; cum.append(acc)
        n = s1 = s2 = 0.0
        sw = sw2 = 0.0
        # The last WINDOW minutes' defence, both sides, as rolling sums.
        win = collections.deque()  # (d_call, d_put, e_call, e_put)
        dsum = [0.0, 0.0, 0.0, 0.0]
        left = set(RULES)
        for m in range(1, LAST + 1):
            dc = dp = ec = ep = 0.0
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                rs = c[m] / c[m - 1] - 1; rp = spy[m] / spy[m - 1] - 1
                x = rs - b_ * rp
                w = 1.0
                if VWEIGHT and umin[m] > 0:
                    w = min(VW_CAP, max(0.1, vol[m] / umin[m]))
                    if VWEIGHT == "sqrt": w = math.sqrt(w)
                wt = w if VW_PARTS in ("both", "t") else 1.0
                wd = w if VW_PARTS in ("both", "d2") else 1.0
                n += 1; sw += wt; sw2 += wt * wt; s1 += wt * x; s2 += wt * x * x
                if rp < 0:
                    ec = wd * x / unit
                    if rs >= 0: dc = -wd * b_ * rp / unit
                if rp > 0:
                    ep = -wd * x / unit
                    if rs <= 0: dp = wd * b_ * rp / unit
            if m < SKIP: dc = dp = ec = ep = 0.0   # the opening minutes left out of the window (the t-stat keeps them)
            win.append((dc, dp, ec, ep))
            for j, v in enumerate((dc, dp, ec, ep)): dsum[j] += v
            if len(win) > WINDOW:
                old = win.popleft()
                for j, v in enumerate(old): dsum[j] -= v
            if m < FIRST or n < MIN_STEPS or c[m] is None: continue
            mu = s1 / sw; var = max(s2 / sw - mu * mu, 0.0)
            t = mu / math.sqrt(var) * math.sqrt(sw * sw / sw2) if var > 0 else 0.0   # unweighted: sw = n, sw*sw/sw2 = n
            med = sorted(h[m] for h in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            rv = cum[m] / usual if usual else 0.0
            for name in list(left):
                if passes(RULES[name], t, rv, dsum[0], dsum[2]): side, d_, e_, t_ = "C", dsum[0], dsum[2], t
                elif passes(RULES[name], -t, rv, dsum[1], dsum[3]): side, d_, e_, t_ = "P", dsum[1], dsum[3], -t
                else: continue
                left.discard(name)
                out[name].append(dict(date=date, sym=sym, right=side, minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}",
                                      price=c[m], b_minute="", a_minute="", c_t=round(t_, 2), c_rvol=round(rv, 2),
                                      c_d=round(d_, 2), c_e=round(e_, 2), sector=""))
            if not left: break
    return out


def main():
    with mp.Pool(8) as pool: parts = pool.map(stock, P["universe"])
    for name in RULES:
        rows = sorted((r for p in parts for r in p[name]), key=lambda r: (r["date"], r["sym"]))
        for y in SPAN:
            ys = [r for r in rows if r["date"][:4] == y]
            with open(f"{B}/s_sig_{name}{SUFFIX}_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(ys)
        print(name, len(rows), flush=True)


if __name__ == "__main__":
    main()
