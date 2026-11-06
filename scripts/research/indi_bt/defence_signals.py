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
import collections, csv, json, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar, vol_factor
from signals import series, beta
from levels import ctx

B = "data/local/x/bt"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
FIRST, LAST, MIN_STEPS, WINDOW = 10, 374, 10, 30
# BT_FIRST (entry_start.py; the user, 2026-10-28: "What if we start at 5 minutes after the bell? 15 minutes?"): the first
# minute a signal may fire; the t needs min(10, first) steps
FIRST = int(os.environ.get("BT_FIRST", FIRST)); MIN_STEPS = min(MIN_STEPS, FIRST)
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
# Every minute a rule holds, not only the first (the user, 2026-10-27: a second try on the same stock after an early first
# trade; a roll of a big winner when the stock is still where the bot would enter): BT_ALL=1 writes
# s_all_<rule><suffix>_<year>.csv, one row per stock, day and side with the minutes (and their t) where the rule holds.
# BT_SYMS (comma list) replaces the universe; BT_SPAN_END moves the last day of 2026.
ALL = bool(os.environ.get("BT_ALL"))
if os.environ.get("BT_SPAN_END"): SPAN["2026"] = (SPAN["2026"][0], os.environ["BT_SPAN_END"])
VW_CAP = 10.0
# The D2 measure (d2_fix.py; the user, 2026-10-30, after ORCL's shock read D2 5.0 on two minutes: "maybe we can improve
# how we calculate D2? check in the industry"): BT_D2_MODE "" today's; "clipK" caps each minute's excess at +-K/10 x the
# stock's typical 1-minute move (S30 / sqrt 30); "floor" counts only SPY minutes moved >= half SPY's typical 1-minute
# move against the bet; "wspy" weighs each minute by SPY's move / its typical 1-minute move (the downside-capture idea);
# "+hit" also needs the stock to beat SPY x beta on >= 60% of the window's counted minutes, at least 8 of them.
D2_MODE = os.environ.get("BT_D2_MODE", "")
CLIP = int(D2_MODE.split("+")[0][4:]) / 10 if D2_MODE.startswith("clip") else None
FLOOR, WSPY, HIT = D2_MODE.startswith("floor"), D2_MODE.startswith("wspy"), D2_MODE.endswith("+hit")
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
    for x in (5, 10, 15, 20):
        RULES[f"c{lt}_{x}"] = (T_MIN, x / 10, "e", lt / 10)
# Controls for the bonus arm: the lower t alone, without any defence.
RULES["t12"] = (1.2, None, "d", None)
RULES["t15"] = (1.5, None, "d", None)
# The sum (sum_entry.py; the user, 2026-10-28: "Buy if the sum of t d2 and volume is more than 4.5 AND t>=0.8"): t + D2 +
# the day volume ratio > S, and t >= 0.8; no separate volume floor (the volume is in the sum)
for x in (40, 45, 50):
    RULES[f"s{x}_08"] = ("sum", x / 10, 0.8)
# The market day (mkt_rules.py; the user, 2026-10-29: "when it big red or big green - lower the treshold needed to enter"):
# the champion's rule (c12_15), or, when SPY has moved >= L from the day before's close to this minute on the bet's side,
# t >= T with the day volume >= 1.5x. mL_T: L in tenths of a percent, T in tenths
for lv, tl in ((5, 12), (3, 12), (10, 12), (5, 10)):
    RULES[f"m{lv}_{tl}"] = ("mkt", lv / 1000, tl / 10, "c12_15")
# The shock (shock_test.py; the user, 2026-10-30: "see the shock alert and if we get one - you can reduce the T V D
# trshvolds by 30%-50%. after you enter you need to confirm that during the next X minutes we do go through that
# threshold"): BT_SHOCKS = f60_alerts.py's json at 15x. For 30 minutes after a shock, on its side, the champion's rule
# (c12_15) with t, the bonus t, D2 and the day volume cut by C/100 (shC), or with t / bonus t / D2 cut and no volume
# floor, the shock being the volume (shvC). A lowered entry records the first later minute the full rule holds (confirm).
SHOCK_WIN = 30
for cut in (30, 50):
    RULES[f"sh{cut}"] = ("shock", cut / 100, False)
    RULES[f"shv{cut}"] = ("shock", cut / 100, True)
SHOCKS = collections.defaultdict(list)   # (sym, date) -> [(first minute, side)]
if os.environ.get("BT_SHOCKS"):
    for a in json.load(open(os.environ["BT_SHOCKS"])):
        SHOCKS[(a["sym"], a["date"])].append(((a["sec"] - 1) // 60, "C" if a.get("move", 0) > 0 else "P"))
# The volume against SPY's (rel_volume.py; the user, 2026-11-03: "if today the main bot does not normelized the spy volume
# I think it might be a good candidate"): BT_REL=1 adds c_rel to every row (the day volume ratio over SPY's own ratio at
# that minute, each vs its 20 sessions before) and the rules <rule>_ra15 (the volume test passes on rv >= 1.5 OR rel >=
# 1.5) and <rule>_rrXXX (on rel >= XXX/100 instead of rv), for the champion's entry c12_15 and the add's base.
REL = bool(os.environ.get("BT_REL"))
BASE_RULES = dict(RULES)
if REL:
    for inner in ("c12_15", "base"):
        RULES[f"{inner}_ra15"] = ("relv", inner, "add", 1.5)
        for lv in (125, 150, 200):
            RULES[f"{inner}_rr{lv}"] = ("relv", inner, "rel", lv / 100)
# The volume after a flip (vol_flip.py; the user, 2026-11-05: "when T is switching from call to put, the volume stay -
# correct?", then "try all of them"): the day volume ratio counts every share since the open, so a morning's selloff
# volume also passes (and sizes) a later call. BT_FLIP=1 adds c_opp (the opposite side's highest t earlier today), c_rv30,
# c_share and c_rvflip to every row, and three families on the champion's entry c12_15 and the add's base:
#   <rule>_r30XXX    the volume of the last 30 minutes over the usual of that window >= XXX/100, instead of rv
#   <rule>_dirXX     rv >= 1.5x and >= XX% of the volume since the open on minutes the stock moved the bet's way (stock
#                    minus beta x SPY)
#   <rule>_flipXX    when the opposite side's t reached XX/10 earlier today, the ratio counts from the last minute this
#                    side's t was <= 0 (the volume since then over the usual of that span), instead of since the open
FLIP = bool(os.environ.get("BT_FLIP"))
if FLIP:
    for inner in ("c12_15", "base"):
        for lv in (125, 150, 200): RULES[f"{inner}_r30{lv}"] = ("volx", inner, "r30", lv / 100)
        for lv in (50, 55, 60): RULES[f"{inner}_dir{lv}"] = ("volx", inner, "dir", lv / 100)
        for lv in (10, 15, 18): RULES[f"{inner}_flip{lv}"] = ("volx", inner, "flip", lv / 10)
# The late window (late_carry.py; the user, 2026-11-06: "reset the signals ... half an hour before the close ... and then
# allow the bots to re-enter a new trade", "the whole day volume is not necessarily an enter"): BT_LATE=<minute> writes
# s_late_<year>.csv, every minute from <minute> to 15:44 where the champion's strength holds (t >= 1.8, or t >= 1.2 and
# D2 >= 1.5) on a side, with no volume test, and the day ratio (c_rvol) and the last 30 minutes' ratio (c_rv30) beside it.
LATE = int(os.environ.get("BT_LATE", 0))
if LATE: FLIP = True
SPYCUM = {}


def spy_ratio(date, i, cal):
    """SPY's volume since the open through each minute over the median of the same span in the 20 sessions before, or None."""
    if date in SPYCUM: return SPYCUM[date]
    def cum(d):
        v = [0] * 390
        for x in day("SPY", d): v[x[0]] = x[5]
        acc, out = 0, []
        for x in v: acc += x; out.append(acc)
        return out
    hist = [h for h in (cum(d) for d in cal[i - 20:i]) if h[-1] > 0]
    today = cum(date)
    out = None
    if len(hist) >= 10 and today[-1] > 0:
        out = []
        for m in range(390):
            med = sorted(h[m] for h in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            out.append(today[m] / usual if usual else None)
    SPYCUM[date] = out
    return out
if os.environ.get("BT_RULES"): RULES = {k: RULES[k] for k in os.environ["BT_RULES"].split(",")}


def shock_low(rule, t, rv, e):
    """The lowered rule inside a shock's window (the "shock" rules)."""
    k = 1 - rule[1]
    if not rule[2] and rv < RV_MIN * k: return False
    return t >= T_MIN * k or (t >= 1.2 * k and e >= 1.5 * k)


def passes(rule, t, rv, d, e, sm=0.0, rel=None):
    """sm: SPY's move from the day before's close to this minute, on the bet's side (the "mkt" rules); rel: the volume
    ratio over SPY's (the "relv" rules). A "volx" rule gets its side's own volume ratio as rv (vol_rv)."""
    if rule[0] == "volx": return passes(RULES[rule[1]] if rule[1] in RULES else BASE_RULES[rule[1]], t, rv, d, e, sm)
    if rule[0] == "relv":
        rel_ok = rel is not None and rel >= rule[3]
        eff = 0.0
        if rule[2] == "add": eff = rv
        if rel_ok: eff = max(eff, RV_MIN)
        return passes(RULES[rule[1]] if rule[1] in RULES else BASE_RULES[rule[1]], t, eff, d, e, sm)
    if rule[0] == "shock": return passes(RULES.get("c12_15", (T_MIN, 1.5, "e", 1.2)), t, rv, d, e)
    if rule[0] == "sum": return t >= rule[2] and t + e + rv > rule[1]
    if rule[0] == "mkt": return passes(RULES[rule[3]], t, rv, d, e) or (sm >= rule[1] and t >= rule[2] and rv >= RV_MIN)
    tt, dx, which, bonus = rule
    if rv < RV_MIN: return False
    dv = d if which == "d" else e
    if bonus is not None: return t >= tt or (t >= bonus and dv >= dx)
    if tt is not None and t < tt: return False
    if dx is not None and dv < dx: return False
    return True


FULL = (T_MIN, 1.5, "e", 1.2)   # the champion's rule c12_15, for the shock rules' confirmation


def stock(sym):
    cal = calendar(); out = {k: [] for k in RULES}
    every = {k: collections.defaultdict(list) for k in RULES}   # BT_ALL: (date, side) -> [(minute, t)]
    late = []   # BT_LATE
    for i, date in enumerate(cal):
        if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
        bars = day(sym, date)
        if len(bars) <= 300: continue
        b_ = beta(sym, date, i, cal)
        if b_ is None: continue
        cx = ctx(sym, date)
        if not cx or not cx["sd"]: continue
        unit = cx["sd"]  # S30 as a fraction of the price
        one = unit / math.sqrt(30)   # the stock's typical 1-minute move
        sx = ctx("SPY", date) if (FLOOR or WSPY) else None
        spy1 = sx["sd"] / math.sqrt(30) if sx and sx["sd"] else None
        if (FLOOR or WSPY) and not spy1: continue
        hist = []
        for d in cal[i - 20:i]:
            v = [0] * 390
            f = vol_factor(sym, d, date, cal)   # in today's shares across a split (B6)
            for x in day(sym, d): v[x[0]] = x[5] * f
            acc, cum = 0, []
            for x in v: acc += x; cum.append(acc)
            if cum[-1] > 0: hist.append(cum)
        if len(hist) < 10: continue
        c = series(bars)[0]; spy = series(day("SPY", date))[0]
        sr = spy_ratio(date, i, cal) if REL else None
        spy_prev = (day("SPY", cal[i - 1]) or [[0, 0, 0, 0, None]])[-1][4]
        umin = [0.0] * 390   # the usual volume of each minute (the median over the 20 sessions before)
        if VWEIGHT:
            for mm in range(390):
                per = sorted(h[mm] - (h[mm - 1] if mm else 0) for h in hist)
                umin[mm] = per[len(per) // 2]
        vol = [0] * 390
        for x in bars: vol[x[0]] = x[5]
        cum, acc = [], 0
        for x in vol: acc += x; cum.append(acc)
        if FLIP:
            def usual_span(a, z):   # the median volume of minutes a+1..z over the 20 sessions before
                med = sorted(h[z] - (h[a] if a >= 0 else 0) for h in hist); k = len(med) // 2
                return med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            vbet = [0.0, 0.0]          # volume on minutes the stock beat beta x SPY (call) / lagged it (put)
            opp = [-99.0, -99.0]       # the highest t of each side so far (call, put)
            lowm = [0, 0]              # the last minute each side's t was <= 0
        n = s1 = s2 = 0.0
        sw = sw2 = 0.0
        # The last WINDOW minutes' defence, both sides, as rolling sums.
        win = collections.deque()  # (d_call, d_put, e_call, e_put, counted call, beat call, counted put, beat put)
        dsum = [0.0] * 8
        left = set(RULES)
        pending = {}
        for m in range(1, LAST + 1):
            dc = dp = ec = ep = 0.0
            nc = bc = np_ = bp = 0
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                rs = c[m] / c[m - 1] - 1; rp = spy[m] / spy[m - 1] - 1
                x = rs - b_ * rp
                if FLIP:
                    if x > 0: vbet[0] += vol[m]
                    elif x < 0: vbet[1] += vol[m]
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
                if D2_MODE:   # the D2 measures of d2_fix.py (ec / ep only; D keeps its own)
                    ec = ep = 0.0
                    for sign, against in ((1, rp < 0), (-1, rp > 0)):
                        if not against or (FLOOR and abs(rp) < 0.5 * spy1): continue
                        xe = sign * x
                        if CLIP is not None: xe = max(-CLIP * one, min(CLIP * one, xe))
                        if WSPY: xe *= abs(rp) / spy1
                        if sign == 1: ec, nc, bc = xe / unit, 1, int(x > 0)
                        else: ep, np_, bp = xe / unit, 1, int(x < 0)
            if m < SKIP: dc = dp = ec = ep = 0.0; nc = bc = np_ = bp = 0   # the opening minutes left out of the window (the t-stat keeps them)
            row = (dc, dp, ec, ep, nc, bc, np_, bp)
            win.append(row)
            for j, v in enumerate(row): dsum[j] += v
            if len(win) > WINDOW:
                old = win.popleft()
                for j, v in enumerate(old): dsum[j] -= v
            if m < FIRST or n < MIN_STEPS or c[m] is None: continue
            e_c, e_p = dsum[2], dsum[3]
            if HIT and not (dsum[4] >= 8 and dsum[5] >= 0.6 * dsum[4]): e_c = -99.0
            if HIT and not (dsum[6] >= 8 and dsum[7] >= 0.6 * dsum[6]): e_p = -99.0
            mu = s1 / sw; var = max(s2 / sw - mu * mu, 0.0)
            t = mu / math.sqrt(var) * math.sqrt(sw * sw / sw2) if var > 0 else 0.0   # unweighted: sw = n, sw*sw/sw2 = n
            med = sorted(h[m] for h in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            rv = cum[m] / usual if usual else 0.0
            rel = None
            if REL and sr and sr[m]: rel = rv / sr[m]
            sm = (spy[m] / spy_prev - 1) if spy_prev and spy[m] else 0.0   # SPY since the day before's close (the "mkt" rules)
            if FLIP:
                # each side's flip context as of the minutes before m (the opposite side's best t, the last t <= 0)
                ctx_c, ctx_p = (opp[1], lowm[0]), (opp[0], lowm[1])
                if t <= 0: lowm[0] = m
                if -t <= 0: lowm[1] = m
                opp[0] = max(opp[0], t); opp[1] = max(opp[1], -t)
                u30 = usual_span(m - 30, m) if m >= 30 else usual
                rv30 = ((cum[m] - cum[m - 30]) if m >= 30 else cum[m]) / u30 if u30 else 0.0
                tot = vbet[0] + vbet[1]
                share = (vbet[0] / tot if tot else 0.5, vbet[1] / tot if tot else 0.5)

                def flip_rv(side):
                    o, c0 = ctx_c if side == 0 else ctx_p
                    if c0 <= 0: return rv, o
                    u = usual_span(c0, m)
                    return ((cum[m] - cum[c0]) / u if u else 0.0), o

                def vol_rv(rule, side):
                    """The volume ratio a volx rule tests for a side (call 0, put 1), scaled so its pass is rv >= 1.5."""
                    mode, lvl = rule[2], rule[3]
                    if mode == "r30": return rv30 * RV_MIN / lvl
                    if mode == "dir": return rv if share[side] >= lvl else 0.0
                    f, o = flip_rv(side)
                    return f if o >= lvl else rv
            if LATE:
                if m >= LATE:
                    for sd, tt, ee in (("C", t, e_c), ("P", -t, e_p)):
                        if tt >= T_MIN or (tt >= 1.2 and ee >= 1.5):
                            late.append(dict(date=date, sym=sym, right=sd, minute=m, price=c[m], c_t=round(tt, 2),
                                             c_e=round(ee, 2), c_rvol=round(rv, 2), c_rv30=round(rv30, 3)))
                continue
            if ALL:
                for name in RULES:
                    if passes(RULES[name], t, rv, dsum[0], e_c, sm, rel): every[name][(date, "C")].append((m, round(t, 2)))
                    if passes(RULES[name], -t, rv, dsum[1], e_p, -sm, rel): every[name][(date, "P")].append((m, round(-t, 2)))
                continue
            full = (passes(FULL, t, rv, dsum[0], e_c), passes(FULL, -t, rv, dsum[1], e_p))   # the champion's rule, call / put
            for name, (j, sd) in list(pending.items()):   # lowered entries waiting for the full rule
                if full[0 if sd == "C" else 1]: out[name][j]["confirm"] = m; del pending[name]
            sh = {s_ for (a_, s_) in SHOCKS.get((sym, date), ()) if a_ <= m <= a_ + SHOCK_WIN}
            for name in list(left):
                r_ = RULES[name]
                if r_[0] == "shock":
                    side = next((s_ for s_, tt, ee, dd in (("C", t, e_c, dsum[0]), ("P", -t, e_p, dsum[1]))
                                 if full[0 if s_ == "C" else 1] or (s_ in sh and shock_low(r_, tt, rv, ee))), None)
                    if side is None: continue
                    t_, d_, e_ = (t, dsum[0], e_c) if side == "C" else (-t, dsum[1], e_p)
                    low = not full[0 if side == "C" else 1]
                    left.discard(name)
                    out[name].append(dict(date=date, sym=sym, right=side, minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}",
                                          price=c[m], b_minute="", a_minute="", c_t=round(t_, 2), c_rvol=round(rv, 2),
                                          c_d=round(d_, 2), c_e=round(e_, 2), sector="", lowered=int(low), confirm=m if not low else ""))
                    if low: pending[name] = (len(out[name]) - 1, side)
                    continue
                rvc = rvp = rv
                if r_[0] == "volx": rvc, rvp = vol_rv(r_, 0), vol_rv(r_, 1)
                if passes(RULES[name], t, rvc, dsum[0], e_c, sm, rel): side, d_, e_, t_ = "C", dsum[0], e_c, t
                elif passes(RULES[name], -t, rvp, dsum[1], e_p, -sm, rel): side, d_, e_, t_ = "P", dsum[1], e_p, -t
                else: continue
                left.discard(name)
                row = dict(date=date, sym=sym, right=side, minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}",
                           price=c[m], b_minute="", a_minute="", c_t=round(t_, 2), c_rvol=round(rv, 2),
                           c_d=round(d_, 2), c_e=round(e_, 2), sector="")
                if REL: row["c_rel"] = "" if rel is None else round(rel, 3)
                if FLIP:
                    si = 0 if side == "C" else 1
                    fr, o = flip_rv(si)
                    row.update(c_opp=round(o, 2), c_rv30=round(rv30, 3), c_share=round(share[si], 3), c_rvflip=round(fr, 3))
                out[name].append(row)
            if not left and not pending: break
    if LATE: return late
    if ALL:
        return {k: [dict(date=d, sym=sym, right=r, minutes=" ".join(str(x[0]) for x in v), ts=" ".join(str(x[1]) for x in v))
                    for (d, r), v in sorted(every[k].items())] for k in RULES}
    return out


def main():
    syms = os.environ["BT_SYMS"].split(",") if os.environ.get("BT_SYMS") else P["universe"]
    with mp.Pool(8) as pool: parts = pool.map(stock, syms)
    if LATE:
        rows = sorted((r for p in parts for r in p), key=lambda r: (r["date"], r["sym"], r["minute"]))
        for y in SPAN:
            ys = [r for r in rows if r["date"][:4] == y]
            if not ys: continue
            with open(f"{B}/s_late{SUFFIX}_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(ys)
        print("late rows", len(rows), flush=True); return
    for name in RULES:
        rows = sorted((r for p in parts for r in p[name]), key=lambda r: (r["date"], r["sym"]))
        for y in SPAN:
            ys = [r for r in rows if r["date"][:4] == y]
            if not ys: continue
            with open(f"{B}/s_{'all' if ALL else 'sig'}_{name}{SUFFIX}_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(ys)
        print(name, len(rows), flush=True)


if __name__ == "__main__":
    main()
