"""Step 2 of the trader study: market context at each of his steps, and at random control minutes.

For every main-account option step with a time (open / add / trim / close / re-enter) it measures,
from 1-minute SIP bars in <dir>/bars.sqlite (scripts/research/indi-bars.ts):
  strength   stock move vs SPY x beta over 5/15/60 min and since the open, signed by the bet
             (call +1, put -1); beta from the prior 20 sessions of 5-min returns
  volume     last-15-min volume vs the same minutes' 20-session median; the largest
             1-min ratio in the 15 min before (burst) and how many minutes before it was
  location   position in the day range so far, distance from VWAP, prior-day high/low,
             opening-range (first 15 min) break, gap at the open, minutes since the open
  option     out-of-the-money %, trading days to expiry, premium as % of the stock price
Index options use an ETF proxy (SPXW -> SPY, NDXP -> QQQ), so their strength vs SPY is ~0.
Control: 20 random regular-session minutes on the same stock, day and bet direction per open.

  python3 scripts/research/indi-features.py <data dir>
Writes <dir>/features.csv (steps) and <dir>/control.csv.
"""
import csv, json, sqlite3, sys, random, statistics as st, datetime as dt
from zoneinfo import ZoneInfo

d = sys.argv[1]
NY = ZoneInfo("America/New_York")
PROXY = {"SPXW": "SPY", "NDXP": "QQQ"}
db = sqlite3.connect(f"{d}/bars.sqlite")
_cache = {}


def day_bars(sym, date):
    """Regular-session 1-min bars [t, o, h, l, c, v] for one NY date (t = bar start, epoch s)."""
    k = (sym, date)
    if k not in _cache:
        row = db.execute("SELECT bars FROM bars WHERE symbol=? AND date=?", (sym, date)).fetchone()
        bars = json.loads(row[0]) if row else []
        out = []
        for b in bars:
            t = dt.datetime.fromtimestamp(b[0], NY)
            m = t.hour * 60 + t.minute
            if 570 <= m < 960:
                out.append(b + [m - 570])  # index 6: minute of session
        _cache[k] = out
    return _cache[k]


def all_dates(sym):
    return [r[0] for r in db.execute("SELECT date FROM bars WHERE symbol=? ORDER BY date", (sym,))]


_dates = {}


def prior_dates(sym, date, n):
    if sym not in _dates:
        _dates[sym] = [x for x in all_dates(sym) if len(day_bars(sym, x)) > 300]
    ds = [x for x in _dates[sym] if x < date]
    return ds[-n:]


def close_at(bars, minute):
    """Close of the last bar that ended at or before session minute `minute`."""
    c = None
    for b in bars:
        if b[6] + 1 <= minute:
            c = b[4]
        else:
            break
    return c


def ret(bars, m0, m1):
    a, b = close_at(bars, m0), close_at(bars, m1)
    return (b / a - 1) if a and b else None


_beta = {}


def beta(sym, date):
    k = (sym, date)
    if k in _beta:
        return _beta[k]
    xs, ys = [], []
    for p in prior_dates(sym, date, 20):
        sb, mb = day_bars(sym, p), day_bars("SPY", p)
        for m in range(5, 391, 5):
            a, b = ret(sb, m - 5, m), ret(mb, m - 5, m)
            if a is not None and b is not None:
                ys.append(a); xs.append(b)
    if len(xs) < 200:
        _beta[k] = None
    else:
        mx, my = st.fmean(xs), st.fmean(ys)
        var = sum((x - mx) ** 2 for x in xs)
        _beta[k] = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / var if var else None
    return _beta[k]


_typ = {}


def typical_volume(sym, date):
    """Median volume per session minute over the prior 20 sessions."""
    k = (sym, date)
    if k not in _typ:
        per = [[] for _ in range(390)]
        for p in prior_dates(sym, date, 20):
            for b in day_bars(sym, p):
                per[b[6]].append(b[5])
        _typ[k] = [st.median(x) if x else None for x in per]
    return _typ[k]


def measure(und, date, minute, bet, strike=None, expiry=None, premium=None):
    sym = PROXY.get(und, und)
    sb, mb = day_bars(sym, date), day_bars("SPY", date)
    if not sb or minute < 1:
        return None
    before = [b for b in sb if b[6] + 1 <= minute]
    if not before:
        return None
    px = before[-1][4]
    prev = prior_dates(sym, date, 1)
    pb = day_bars(sym, prev[0]) if prev else []
    pclose = pb[-1][4] if pb else None
    o = sb[0][1]
    hi, lo = max(b[2] for b in before), min(b[3] for b in before)
    pv = sum(b[5] for b in before)
    vwap = sum((b[2] + b[3] + b[4]) / 3 * b[5] for b in before) / pv if pv else None
    be = beta(sym, date) if sym != "SPY" else 1.0
    f = dict(px=px, minute=minute, beta=be)
    for w in (5, 15, 60):
        r, m = ret(sb, minute - w, minute), ret(mb, minute - w, minute)
        f[f"ex{w}"] = bet * (r - be * m) * 100 if None not in (r, m, be) else None
        f[f"ret{w}"] = bet * r * 100 if r is not None else None
    r, m = (px / o - 1), ret(mb, 0, minute)
    mo = (close_at(mb, minute) / mb[0][1] - 1) if mb else None
    f["ex_open"] = bet * (r - be * mo) * 100 if None not in (be, mo) else None
    f["ret_open"] = bet * r * 100
    f["ret_day"] = bet * (px / pclose - 1) * 100 if pclose else None
    f["gap"] = bet * (o / pclose - 1) * 100 if pclose else None
    rng = hi - lo
    # 1 = at the extreme in the bet's direction (day high for a call, day low for a put).
    f["range_pos"] = ((px - lo) / rng if bet > 0 else (hi - px) / rng) if rng > 0 else None
    f["vs_vwap"] = bet * (px / vwap - 1) * 100 if vwap else None
    if pb:
        ph, pl = max(b[2] for b in pb), min(b[3] for b in pb)
        f["beyond_prev"] = bet * ((px / ph - 1) if bet > 0 else (px / pl - 1)) * 100
    orb = [b for b in sb if b[6] < 15]
    if minute > 15 and orb:
        oh, ol = max(b[2] for b in orb), min(b[3] for b in orb)
        f["or_break"] = 1 if (px > oh if bet > 0 else px < ol) else (-1 if (px < ol if bet > 0 else px > oh) else 0)
    typ = typical_volume(sym, date)
    last15 = [b for b in before if b[6] >= minute - 15]
    tv = [typ[b[6]] for b in last15 if typ[b[6]]]
    f["rvol15"] = sum(b[5] for b in last15) / sum(tv) if tv and sum(tv) else None
    cum_t = [typ[b[6]] for b in before if typ[b[6]]]
    f["rvol_day"] = pv / sum(cum_t) if cum_t and sum(cum_t) else None
    ratios = [(b[5] / typ[b[6]], minute - b[6]) for b in last15 if typ[b[6]]]
    if ratios:
        mx = max(ratios)
        f["burst"], f["burst_ago"] = mx
    if strike is not None and und not in PROXY:
        f["otm"] = ((strike / px - 1) if bet > 0 else (1 - strike / px)) * 100
        f["prem_pct"] = premium / px * 100 if premium else None
    if expiry:
        f["dte"] = len([x for x in (_dates.get(sym) or []) if date < x <= expiry]) + \
            max(0, int(expiry > (_dates.get(sym) or [date])[-1]))
    return f


rows = list(csv.DictReader(open(f"{d}/actions.csv")))
steps, ctrl = [], []
random.seed(7)
for r in rows:
    und, expiry, sr = r["contract"].rsplit(" ", 2)
    if r["account"] != "silexx" or sr.endswith("S") or not r["time_from"] or r["action"].startswith(("exit", "expired")):
        continue
    t = dt.datetime.fromisoformat(f"{r['date']}T{r['time_from']}")
    minute = (t.hour * 60 + t.minute - 570) + (1 if t.second else 0)
    if not 0 < minute <= 390:
        continue
    bet = 1 if sr.endswith("C") else -1
    f = measure(und, r["date"], minute, bet, float(sr[:-1]), expiry, float(r["avg_price"]))
    if not f:
        continue
    steps.append(dict(trade=r["trade"], date=r["date"], time=r["time_from"], und=und, bet=bet, action=r["action"],
                      qty=r["qty"], price=r["avg_price"], **f))
    if r["action"] == "open":
        for m in random.sample(range(16, 390), 20):
            g = measure(und, r["date"], m, bet, float(sr[:-1]), expiry, None)
            if g:
                ctrl.append(dict(trade=r["trade"], date=r["date"], und=und, bet=bet, **g))


def write(path, data):
    keys = list(dict.fromkeys(k for x in data for k in x))
    w = csv.DictWriter(open(path, "w"), fieldnames=keys)
    w.writeheader()
    w.writerows(data)


write(f"{d}/features.csv", steps)
write(f"{d}/control.csv", ctrl)
print(len(steps), "steps,", len(ctrl), "control minutes")
