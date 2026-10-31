"""MODELED option data for years without option prices (bs22.py, 2026-10-31). Not market data.

When MODEL is on, the simulator's option inputs come from Black-Scholes on the stock's own 1-minute bars:
  expiries   every Friday (the trading day before it when it is a holiday): weeklies for every stock
  chain      strikes on a grid by price (under $25: 0.5, $50: 1, $150: 1, $300: 2.5, above: 5), 0.6x to 1.4x the price
             a week before the expiry
  option bar each minute the stock traded: Black-Scholes at the stock's open / high / low / close, the volatility
             K x the stock's 20-session realized volatility (daily closes, the sessions before the day), held for the day;
             K = 1.43 = the median implied / realized volatility of the champion's 0.15-delta picks, 2024-26 (stable:
             1.44 / 1.42 / 1.43 by year); volume a fixed 1,000 a minute (the 200-contract floor always passes)
  fetch      no option downloads
Off, everything is the real store (Alpaca option bars). Known gaps: no skew beyond the calibration, no volatility
change during a trade (earnings crush, panic spikes), no liquidity filter, every stock has weeklies.
"""
import datetime as dt, math, re
import cheap_up as cu
import sim
import store

MODEL = False
K = 1.43
STEP = ((25, 0.5), (50, 1.0), (150, 1.0), (300, 2.5), (1e9, 5.0))
OCC = re.compile(r"^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")
_orig = dict(day=store.day, chain=store.chain, expiries=store.expiries, fetch=store.fetch_bars)
CAL = store.calendar(); IDX = {d: i for i, d in enumerate(CAL)}
_vol, _bars = {}, {}


def vol(und, date):
    k = (und, date)
    if k not in _vol:
        i = IDX.get(date); v = None
        if i and i > 21:
            cs = []
            for d in CAL[i - 21:i]:
                b = _orig["day"](und, d)
                cs.append(b[-1][4] if b else None)
            if all(cs):
                r = [math.log(cs[j] / cs[j - 1]) for j in range(1, len(cs))]
                m = sum(r) / len(r)
                v = K * math.sqrt(sum((x - m) ** 2 for x in r) / len(r) * 252)
        _vol[k] = v
    return _vol[k]


def opt_day(sym, date):
    k = (sym, date)
    if k in _bars: return _bars[k]
    m = OCC.match(sym); out = []
    if m:
        und, exp = m.group(1), f"20{m.group(2)}-{m.group(3)}-{m.group(4)}"
        call, strike = m.group(5) == "C", int(m.group(6)) / 1000
        v = vol(und, date)
        if v and date <= exp:
            px = lambda S, mm: max(0.01, round(store.bs(S, strike, store.years_to_expiry(date, mm, exp), v, sim.C["rate"], call)[0], 2))
            for b in _orig["day"](und, date):
                mm = b[0]
                hi, lo = (b[2], b[3]) if call else (b[3], b[2])
                out.append([mm, px(b[1], mm), px(hi, mm), px(lo, mm), px(b[4], mm), 1000])
    _bars[k] = out
    return out


def day(sym, date):
    if MODEL and OCC.match(sym): return opt_day(sym, date)
    return _orig["day"](sym, date)


def expiries(und, start, end):
    if not MODEL: return _orig["expiries"](und, start, end)
    a, b = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    out, d = [], a + dt.timedelta(days=(4 - a.weekday()) % 7)
    while d <= b:
        x = d
        while x.isoformat() not in IDX and x > d - dt.timedelta(days=4): x -= dt.timedelta(days=1)
        if x.isoformat() in IDX or x.isoformat() > CAL[-1]: out.append(x.isoformat())
        d += dt.timedelta(days=7)
    return out


def chain(und, expiry, right):
    if not MODEL: return _orig["chain"](und, expiry, right)
    ref = (dt.date.fromisoformat(expiry) - dt.timedelta(days=7)).isoformat()
    i = max(0, min(len(CAL) - 1, next((j for j in range(len(CAL) - 1, -1, -1) if CAL[j] <= ref), 0)))
    b = _orig["day"](und, CAL[i])
    if not b: return []
    p = b[-1][4]; step = next(s for lim, s in STEP if p < lim)
    lo, hi = math.floor(0.6 * p / step) * step, math.ceil(1.4 * p / step) * step
    n = int(round((hi - lo) / step))
    return [round(lo + j * step, 2) for j in range(n + 1)]


def fetch_bars(kind, symbols, start, end, key=None, end_minute=None):
    if MODEL and kind == "options": return
    return _orig["fetch"](kind, symbols, start, end, key=key, end_minute=end_minute)


def set_model(on):
    global MODEL
    MODEL = bool(on)
    sim._exp.clear()


# wire the switches into the modules that imported the store's functions by name
for mod in (sim, cu):
    if hasattr(mod, "day"): mod.day = day
sim.chain, sim.expiries, sim.fetch_bars = chain, expiries, fetch_bars
