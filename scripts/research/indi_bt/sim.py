"""Trade simulation: for each signal, pick the contract and walk it minute by minute to the exit.

Contract   nearest expiry dte_min..dte_max calendar days out; the out-of-the-money strike whose delta
           (Black-Scholes, implied vol of the last bar price within bar_max_age minutes) is closest to
           `delta`; skipped when that contract has < min_vol30 contracts in the last 30 minutes or costs
           < min_price. Never falls back to another contract.
Fills      (BT_LIMIT set: the buy is a limit at the last option price seen at the signal, + BT_LIMIT,
           filled at the limit on the first bar within limit_minutes that trades at or below it.)
           decided on one option bar, filled on the next bar of that contract at the bar middle
           (high+low)/2 + spread_half (buy) or - spread_half (sell), plus commission per contract.
Exits      (gain g = option bar close / entry fill - 1, checked on every option bar)
  L3 floor     g <= floor                                  -> sell all
  L1 first cut g <= cut1 on cut1_confirm bars in a row, after min_hold minutes, once
                                                           -> sell cut1_share of what is left
  L2 stall     after L1, g < 0 and the stock made no new extreme for stall_min minutes
               or fell rs_drop % vs SPY x beta in 5 minutes -> sell all
  W1 even      g reached win_arm, then g <= 0              -> sell all
  W2 takes     each [gain, share] of `takes` in turn: g >= gain -> sell that share of the original;
               when `fast_minutes` is set and the first take's gain came within that many minutes of
               the entry, the `fast_takes` plan is used instead (it starts higher)
  W4 runner    after W2: 'trail' off the peak price, or no new stock extreme for runner_stall_min
               minutes                                     -> sell all
  R roll (roll {gain | near, within, share, rest_take}): the option at +gain (or the stock close to the
               strike, see roll_hit) within `within` minutes of the entry -> sell `share` (tiers.py buys a
               new contract); the rest is sold at +rest_take
  X stall exit (stall_exit {arm, min, giveback?, vol?}): once the option has been up `arm`, sell all when the
               stock has made no new extreme our way for `min` minutes, the option is `giveback` under its peak, and
               (with `vol`) the last 15 minutes' volume is under `vol` × the 15 minutes up to the option's peak;
               (with `below`) only while the gain is under `below`
  K locks (locks [[arm, floor], ...]): once the option's peak is up `arm`, sell all when it falls to `floor`
  T time stop (time_stop {min, need}): `min` minutes after the entry, sell all unless up `need`
  G guard (guard {arm, floor | trail, day0}): once the option has been up `arm` (peak close vs the entry fill),
               sell all when the gain falls to `floor`, or the price falls `trail` from its peak; day0: the entry day only
  N night trail (night_trail x): on a carried day, after the morning rule kept a part, sell it when the option
               closes x under its highest close since the morning
  U your stop (user_stop {every: {from, to, share}} sells `share` at the first minute in the window the stock is
               against the entry, once; then {checks: [[10, 0.5], [20, 1.0]], out} or {check_from, check_to, share, out}):
               at each checkpoint (minutes after the entry, once), the stock on the wrong side of the entry
               price -> sell that share of what is left. With opt_below (e.g. -0.10) the option must also be at that gain
               or worse; with opt_wait a check not met stays armed until both hold, else it passes once. Older form: 10-20 minutes after the entry, the stock
               on the wrong side of the entry price -> sell `share` (once); option at `out` (e.g. -35%)
               with the stock on the wrong side of the entry price -> sell all; out_by_dte [[max dte, out], ...]
               picks `out` by the days to expiry at the entry (first row the trade fits)
  Z stall + strength (stall_rs {hours, gain, rs}): entry day, from `hours` after the entry, the option never up `gain`
               since the entry and (rs "entry" / "hour") the stock's move vs SPY x beta since the entry / over the last hour
               against us                                               -> sell all
  Q still (still {window, k, under}): entry day, from `window` minutes after the entry, the stock's high-low range over the
               last `window` minutes under k x its usual move for that span (S30 x sqrt(window/30), levels.py); with `under`
               only while the option is under that gain                 -> sell all
  B big trail (big_trail {arm, k}): once the option was up `arm` (any day held), the stock gives back k x S30 from its
               best since then                             -> sell all
  S level stop (level_stop {buffer, nth}): on the entry day, the stock closes `buffer` x S30 beyond the nth nearest level
               behind the entry price (levels.py: yesterday's / the 5-day high and low, the first 15 minutes', the day's so far)
                                                           -> sell all
  first_exit_min N: on the entry day no -X% stop and no failed-break sale in the first N minutes (the checks keep their times)
  hold_first N: on the entry day no stop of any kind (the checks, -X%, the rest, the t-stat exit, the failed break) in the
               first N minutes after the entry; then the rules as usual, a check whose time has passed fires at once
               (user, 2026-10-25: "no stop for 30 minutes" on the pre-market D2 entries, premarket_d2.py)
  rebuy {mode, off, until}: after the +10 check sold part, buy that part back once on the entry day (until minute
               `until`): mode "at20" when the stock is not against at the 20-minute check, mode "back" at the first close
               `off` (price units) past the entry price our way; next bar at the middle + SH. The stops and the hold
               then measure the gain from the average cost; result() pays for the rebuy (user, 2026-10-24)
               min_t / t_over (refill.py, 2026-10-29): only when the stock's t vs SPY x beta is at least min_t, and / or
               t_over above its t at the entry (needs "thesis", which computes the t series)
  user_stop.rest_after_half: once a check sold part, the later checks sell regardless of the stock (the rest out at +20)
  after_half {out, need_against, stock}: on the entry day once the +10 check sold half, the rest out at `out` (a gain,
               or "half_px": under the half's sale price), with the stock against unless need_against False; stock True:
               the rest out at the first minute after +20 with the stock against the entry
  early_out {min, out}: on the entry day the -X% stop is `out` (e.g. -0.5) in the first `min` minutes, then user_stop.out
  T thesis (thesis {s30, bar, t}): entry day, the stock closes `s30` S30 units against the entry price (T_s30), or past the
               signal bar's low / high (T_bar), or the signal's cumulative t vs SPY x beta falls to `t` or under (T_tstat)
                                                                       -> sell all
  DF defence broken (defence {window, out}): entry day, from `window` minutes after the entry, the D2 of the last
               `window` minutes (the stock's excess move vs SPY x beta on the minutes SPY moved against the bet, in the
               bet's direction, in S30 units of the price) is `out` or under (user, 2026-10-25)  -> sell all
  S stock stop (stock_stop "vwap" / "prev", entry day): the stock closes back on the wrong side of
               VWAP, or back inside yesterday's range                    -> sell all
  EOD 15:50    carry only if g >= carry_min_gain, stock at >= carry_range_pos of the day range,
               not Friday, >= carry_min_dte days to expiry -> else sell all
  carry_max_days  nights a position may be carried (default: no limit)
  morning      after a carry, at 09:30 + morning_minute: gap in the bet direction >= gap_keep %
               -> sell gap_sell_share, keep the rest under the rules; otherwise sell all
  expiry day   sell all at 09:30 + expiry_last_minute
  V volume fade (vol_fade {min, until}): entry day, for an entry taken with the day's volume under `until` x normal:
               sell all at the first minute, `min` minutes or more after the entry, when the day's volume ratio is
               lower than `min` minutes earlier and still under `until`; once it reaches `until` the rule is off
               (user, 2026-10-24: "if the volume stops increasing and we are not reaching 1.5x, exit")
  A alert silence (alert_silence {min}): entry day; no volume alert on the stock (rvol_alert.py, either direction)
               in the `min` minutes after the entry -> sell all at that minute (user, 2026-10-25; built for 0DTE)
  F failed break (failed_break True): on the entry day, the stock reached the next level ahead and fell back without
               breaking it (failed_break_minute) -> sell all on the next bar (the user's chosen bot, 2026-10-23)
Each trade's result is a return on the premium paid (`ret`, after costs); sizing is in report.py.

  python3 sim.py [signals.csv] [out prefix] [shard/shards]  -> <prefix>_trades.csv, <prefix>_steps.csv
  (with a shard, only every shards-th signal from `shard`, written to <prefix>.<shard>_*.csv;
  report.py reads all shards of a prefix)
"""
import csv, math, datetime as dt, json, os, sys
from store import P, DATA, day, calendar, chain, expiries, fetch_bars, occ, iv_delta, years_to_expiry
from signals import Day, series

C, X, SH = dict(P["contract"]), dict(P["exit"]), P["cost"]["spread_half"]
if os.environ.get("BT_CONTRACT"): C.update(json.loads(os.environ["BT_CONTRACT"]))  # e.g. {"delta": 0.3}
VARIANT = os.environ.get("BT_VARIANT")  # an exit variant from params.json "exit_variants"
if VARIANT: X.update({k: v for k, v in P["exit_variants"][VARIANT].items() if not k.startswith("_")})
if os.environ.get("BT_EXIT"): X.update(json.loads(os.environ["BT_EXIT"]))  # ad-hoc overrides for sweeps
LIMIT = os.environ.get("BT_LIMIT") is not None  # buy with a limit at the last option price seen (+ BT_LIMIT, e.g. 0.01)
LIMIT_PAD = float(os.environ.get("BT_LIMIT") or 0)
FILL = os.environ.get("BT_FILL")  # "close" / "mid": fill the buy on the signal bar; "open": the next bar's open
COMM = P["size"]["commission"]
RISK_PCT = P["size"]["risk_pct"]  # the size every result is reported at unless told otherwise (1% of the account)
# The overnight cap (the user, 2026-10-25: "10% cap overnight ALWAYS and everywhere"): at 15:50 what is held into the
# night is worth at most this share of the account, the excess sold at the close (as the live bot's nightCapPct). The
# shares in a walk's steps are the uncapped ones; result() applies the cap for the size it is asked for.
NIGHT_CAP = float(os.environ["BT_NIGHT_CAP"]) if os.environ.get("BT_NIGHT_CAP") is not None else float(X.get("night_cap") or 0)
_exp = {}


def expiry_for(und, date):
    lo = (dt.date.fromisoformat(date) + dt.timedelta(days=C["dte_min"])).isoformat()
    hi = (dt.date.fromisoformat(date) + dt.timedelta(days=C["dte_max"])).isoformat()
    k = (und, date[:7])
    if k not in _exp:
        m0 = date[:7] + "-01"
        _exp[k] = expiries(und, m0, (dt.date.fromisoformat(m0) + dt.timedelta(days=40)).isoformat())
    return next((e for e in _exp[k] if lo <= e <= hi), None)


def last_bar(bars, minute, age):
    b = [x for x in bars if minute - age < x[0] <= minute]
    return b[-1] if b else None


def pick(und, date, minute, right, spot):
    """-> (symbol, expiry, strike, delta, price, vol30, implied vol) or (None, reason)."""
    exp = expiry_for(und, date)
    if not exp: return None, "no_expiry"
    call = right == "C"
    allk = chain(und, exp, right)
    ks = [k for k in allk if (spot <= k <= spot * (1 + C["otm_scan_max"]) if call else spot * (1 - C["otm_scan_max"]) <= k <= spot)]
    ks = sorted(ks, key=lambda k: abs(k - spot))[:C["max_strikes"]]
    if not ks: return None, "no_strikes"
    syms = [occ(und, exp, k, right) for k in ks]
    # Download once per stock, expiry, side and day: every strike within 30% of the open, the whole day,
    # so any later test (another minute, delta or roll) reads it from the cache.
    sb = day(und, date)
    o = sb[0][1] if sb else spot
    wide = [occ(und, exp, k, right) for k in allk if abs(k / o - 1) <= 0.30]
    for i in range(0, len(wide), 80):  # the API takes up to 100 symbols a request
        fetch_bars("options", wide[i:i + 80], date, date, key=f"day|{und}|{exp}|{right}|{date}|{i}")
    if any(not day(s, date) for s in syms[:3]):  # spot far from the open: the nearest strikes up to this minute
        fetch_bars("options", syms, date, date, key=f"cand|{und}|{exp}|{right}|{date}|{ks[0]}|{ks[-1]}|{minute}", end_minute=minute)
    T = years_to_expiry(date, minute, exp)
    best = None
    for k, s in zip(ks, syms):
        b = last_bar(day(s, date), minute, C["bar_max_age"])
        if not b: continue
        x = iv_delta(b[4], spot, k, T, C["rate"], call)
        if x is None: continue
        iv, d = x
        if best is None or abs(d - C["delta"]) < abs(best[3] - C["delta"]):
            best = (s, exp, k, d, b[4], sum(y[5] for y in day(s, date) if minute - 30 < y[0] <= minute), iv)
    if not best: return None, "no_prices"
    if best[4] < C["min_price"]: return None, "too_cheap"
    if best[5] < C["min_vol30"]: return None, "illiquid"
    return best, None


def mid(b): return (b[2] + b[3]) / 2


_rv = {}


def rvol_series(und, d, cal):
    """The stock's volume since the open / the median of the same minute over the prior 20 sessions (as the C signal),
    by minute, or None without 10 prior sessions with data."""
    k = (und, d)
    if k in _rv: return _rv[k]
    i = cal.index(d); hist = []
    for p in cal[max(0, i - 20):i]:
        v = [0] * 390
        for x in day(und, p): v[x[0]] = x[5]
        acc, cum = 0, []
        for x in v: acc += x; cum.append(acc)
        if cum[-1] > 0: hist.append(cum)
    out = None
    if len(hist) >= 10:
        v = [0] * 390
        for x in day(und, d): v[x[0]] = x[5]
        acc, cum = 0, []
        for x in v: acc += x; cum.append(acc)
        out = []
        for m in range(390):
            med = sorted(h[m] for h in hist); n = len(med)
            u = med[n // 2] if n % 2 else (med[n // 2 - 1] + med[n // 2]) / 2
            out.append(cum[m] / u if u else None)
    _rv[k] = out
    return out


def roll_hit(R_, g, sd, t, minute, sym, bet):
    """The roll trigger: the option up R_["gain"], or with R_["near"] the stock has come close to the strike: what is
    left of the way from the entry price to the strike is at most `near` of it (0 = at the money)."""
    if "near" not in R_: return g >= R_["gain"]
    if not sd.ok: return False
    s0, s = sd.c[minute], sd.c[min(t, 389)]
    k = float(sym[-8:]) / 1000
    if not s0 or not s or bet * (k - s0) <= 0: return False
    return bet * (k - s) / (bet * (k - s0)) <= R_["near"]


def failed_break_minute(und, date, minute, bet):
    """The entry day's failed break (levels.py; the bot's levels.ts): the minute the stock, having reached the next level
    ahead of the signal, closed 0.5 S30 back from it within 30 minutes without breaking it; None if it did not."""
    from levels import ctx, ahead, NEAR, BREAK, BACK, WAIT, EOD
    x = ctx(und, date)
    a = ahead(x, minute, bet) if x and x["c"][minute] is not None else None
    if not a: return None
    lv, sd0, touch = a[1], x["sd"] * x["c"][minute], None
    for m in range(minute + 1, EOD):
        p = x["c"][m]
        if p is None: continue
        d = bet * (lv - p) / sd0
        if d <= -BREAK: return None
        if d <= NEAR and touch is None: touch = m
        if touch is not None and m - touch > WAIT: return None
        if touch is not None and d >= BACK: return m
    return None


# The audit of 2026-10-31 (the user: "fix it. also fix #1"), both off by default so earlier runs reproduce:
#   BT_KEEP=1      a signal whose option did not trade in the 3 minutes after it is still bought (it was dropped as
#                  "no_fill": live, the bot owns that option); priced like a minute with no trade below
#   BT_CLOCK=stock the walk checks every minute the STOCK traded, as the live bot does, not only minutes the option
#                  traded (a thin option's 10-minute check ran at its next print, IBIT 2026-10-30: 13:01 for 11:27);
#                  each minute's option price is its book mid as that minute closed (real_bench.quote), as the live
#                  bot marks it (its -30% stop and checks read the mid), else that minute's trade bar, else the last
#                  trade. Implies BT_KEEP. Not modelled either way: the broker's own safety stop (50%), any second.
CLOCK = os.environ.get("BT_CLOCK", "")
KEEP = os.environ.get("BT_KEEP") == "1" or CLOCK == "stock"


def book_bar(sym, d, t, last):
    """A bar for minute t when the option did not trade: the book's mid as t closed, else the last trade, else None."""
    import real_bench as RB
    q = RB.quote(sym, d, t)
    if q and q[1] > 0:
        m = (q[0] + q[1]) / 2
        return [t, m, m, m, m, 0]
    if last:
        c = last[4]
        return [t, c, c, c, c, 0]
    return None


def walk_bars(und, sym, d, start, last):
    """The bars the walk reads on day d: the option's trade bars, or with BT_CLOCK=stock one per stock minute."""
    bars = day(sym, d)
    if CLOCK == "stock":
        ob = {b[0]: b for b in bars}
        seq = []
        for sb in day(und, d):
            t = sb[0]
            # the mark the live bot reads: the book's mid every minute (its stops and checks use the option's mid); a
            # trade bar only when there is no book
            q = book_bar(sym, d, t, None) if t > start else None
            b = q or ob.get(t) or (book_bar(sym, d, t, last) if t > start else None)
            if b: seq.append(b); last = b
        return seq
    if KEEP and start >= 0 and not any(start < b[0] <= start + 3 for b in bars):
        b = book_bar(sym, d, start + 1, last)
        if b: return [b] + [x for x in bars if x[0] > start + 1]
    return bars


# BT_X='{"carry_min_gain": 0.25}': exit settings laid over whatever the caller set (nested dicts merged), for a test
# that changes one exit rule without editing the scripts (the user 2026-10-31: overnight from +25%, stops -35% to -50%)
OVR = __import__("json").loads(os.environ.get("BT_X", "{}"))


def overlay(x, o):
    for k, v in o.items():
        if isinstance(v, dict) and isinstance(x.get(k), dict): x[k] = dict(x[k]); overlay(x[k], v)
        else: x[k] = v


# BT_SEC_EXIT=1 (the user 2026-10-31: "use one second exit ... Black-Scholes -3% / bid, the lower of the 2"): on the entry
# day the price stops (U_out: the -X% stop with the stock against; U_rest: the rest after the half) are checked every
# second, on the option valued by Black-Scholes at the stock's 1-second close (sec_cache/main/stock, the whole entry
# day) with the implied volatility of its mid as the minute before closed; a hit sells at once at the lower of that
# value - 3% and the last bid (the book as the minute before closed). Rule names end "_1s"; the real-fill pricing keeps
# their price. Time checks (10 / 20 minutes, 15:50) and carried days stay on minutes.
SEC_EXIT = os.environ.get("BT_SEC_EXIT") == "1"
_SECS = {}


def stock_secs(sym, d):
    k = (sym, d)
    if k not in _SECS:
        if len(_SECS) > 40: _SECS.clear()
        import gzip
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sec_cache", "main", "stock", f"{d}_{sym}.csv.gz")
        _SECS[k] = {int(r[0]): float(r[4]) for r in csv.reader(gzip.open(p, "rt")) if r} if os.path.exists(p) else None
    return _SECS[k]


def sec_stop(und, sym, d, t, minute, bet, basis, st, uout, exp, sp0):
    """-> (second, price, rule) of the first price stop inside minute t, or None."""
    import real_bench as RB
    from store import bs
    secs = stock_secs(und, d)
    if not secs or t < 1: return None
    q = RB.quote(sym, d, t - 1)
    prev = (q[0] + q[1]) / 2 if q and q[1] > 0 else None
    if prev is None:
        b = last_bar(day(sym, d), t - 1, 30)
        prev = b[4] if b else None
    s_prev = next((secs[x] for x in range(60 * t - 1, 60 * t - 61, -1) if x in secs), None)
    if not prev or not s_prev: return None
    K = float(sym[-8:]) / 1000; call = bet > 0
    T = years_to_expiry(d, t, exp)
    x = iv_delta(prev, s_prev, K, T, C["rate"], call)
    if not x: return None
    iv = x[0]
    AH = X.get("after_half")
    for sec in range(60 * t, 60 * t + 60):
        px = secs.get(sec)
        if px is None: continue
        v = bs(px, K, T, iv, C["rate"], call)[0]
        g = v / basis - 1
        against = bet * (px - sp0) < 0
        rule = None
        if AH and st.get("half_q"):
            lvl = st["half_px"] / basis - 1 if AH.get("out") == "half_px" else AH.get("out")
            if lvl is not None and g <= lvl and (against or not AH.get("need_against", True)): rule = "U_rest_1s"
        if rule is None and g <= uout and against: rule = "U_out_1s"
        if rule:
            bid = q[0] if q else None
            price = v * 0.97 if bid is None else min(v * 0.97, bid)
            return sec, max(price, 0.0), rule
    return None


def walk(und, date, minute, right, sym, exp, cal, limit=None):
    """Walks one contract from the signal minute to the last sale. -> (entry, steps, flags)."""
    if OVR: overlay(X, OVR)
    bet = 1 if right == "C" else -1
    i0 = cal.index(date)
    dates = [d for d in cal[i0:] if d <= exp]
    fetch_bars("options", [sym], date, exp)
    steps, rem, cost, peak = [], 1.0, None, None
    if FILL in ("close", "mid") and limit is None:  # BT_FILL: buy on the signal bar itself, at its close ("close") or its middle ("mid", looks ahead)
        b0 = last_bar(day(sym, date), minute, C["bar_max_age"])
        if b0:
            cost = (b0[4] if FILL == "close" else mid(b0)) * (1 + SH); peak = b0[4]; basis = cost
            steps.append((date, minute, "buy", 1.0, round(cost, 4), f"entry_{FILL}"))
    st = dict(cut1=False, armed=False, t1=False, plan=None, k=0)
    pending = None  # (share of original or 'all', rule)
    fb = failed_break_minute(und, date, minute, bet) if X.get("failed_break") else None
    # the -X% stop can depend on days to expiry at the entry: out_by_dte [[max dte, out], ...] (user, 2026-10-24)
    uout = (X.get("user_stop") or {}).get("out")
    if X.get("user_stop") and X["user_stop"].get("out_by_dte"):
        dte0 = (dt.date.fromisoformat(exp) - dt.date.fromisoformat(date)).days
        uout = next((o for lim, o in X["user_stop"]["out_by_dte"] if dte0 <= lim), uout)
    last = last_bar(day(sym, date), minute, 390) if KEEP else None   # the option's last trade at the signal
    for k, d in enumerate(dates):
        bars = walk_bars(und, sym, d, minute if k == 0 else -1, last) if KEEP else day(sym, d)
        if bars: last = bars[-1]
        sd = Day(und, d, bet, cal, cal.index(d))
        spyc = series(day("SPY", d))[0] if X.get("stall_rs") and k == 0 else None
        start = minute if k == 0 else -1
        carry_day = k > 0
        eod_done = False
        for b in bars:
            t = b[0]
            if t <= start: continue
            if cost is None:
                if limit is not None:  # a limit at the price seen at the signal
                    if t > minute + C["limit_minutes"]: return None, [], "limit_not_filled"
                    if b[3] > limit: continue
                    cost = limit
                else:
                    if t > minute + 3: return None, [], "no_fill"
                    cost = (b[1] if FILL == "open" else mid(b)) * (1 + SH)
                peak = b[4]; basis = cost
                steps.append((d, t, "buy", 1.0, round(cost, 4), "entry_limit" if limit is not None else "entry"))
                continue
            early = k == 0 and t - minute < X.get("first_exit_min", 0)  # no stop / failed-break sale this soon after the entry (user, 2026-10-24)
            hold = k == 0 and t - minute < X.get("hold_first", 0)  # no stop of any kind yet (hold_first)
            early = early or hold
            if fb is not None and k == 0 and t > fb and cost is not None and not early:  # the failed-break sale: all of what is left
                steps.append((d, t, "sell", round(rem, 4), round(max(mid(b) * (1 - SH), 0.01), 4), "F_break"))
                return cost, steps, ""
            if st.get("rb_pending"):  # the rebuy (rebuy): the part sold at the +10 check, back at this bar
                st["rb_pending"] = False; st["rebought"] = True
                q = st.get("rb_q") or st["half_q"]; p_ = mid(b) * (1 + SH)
                basis = (rem * basis + q * p_) / (rem + q); rem += q
                steps.append((d, t, "buy", round(q, 4), round(p_, 4), "rebuy"))
            if pending:
                share, rule = pending
                q = rem if share == "all" else min(rem, share)
                rem -= q
                steps.append((d, t, "sell", round(q, 4), round(max(mid(b) * (1 - SH), 0.01), 4), rule))
                if rule == "U_check10": st["half_q"], st["half_px"] = q, steps[-1][4]
                pending = None
                if rem <= 1e-9: return cost, steps, ""
            if SEC_EXIT and k == 0 and X.get("user_stop") and sd.ok and not early and t > minute + 1 and uout is not None:
                if st.get("sp0") is None: st["sp0"] = sd.c[minute]
                hit = sec_stop(und, sym, d, t, minute, bet, basis, st, uout, exp, st["sp0"]) if st["sp0"] else None
                if hit:
                    steps.append((d, t, "sell", round(rem, 4), round(hit[1], 4), hit[2]))
                    return cost, steps, ""
            NX = X.get("night_x")  # carried days: stop / take profit from the last 15:50 price (night_x.py)
            if NX and carry_day and t >= NX["from"] and t < X["eod_minute"]:
                c = b[4]; ref = next(s[4] for s in reversed(steps) if s[2] == "carry")
                if st.get("nx_k") != k: st.update(nx_k=k, nx_took=False)
                early = t < NX.get("early_until", -1)
                if st["nx_took"]: level, rule = ref * (1 + NX["after_take"]), "NX_after_take"
                elif early: level, rule = ref * (1 + NX["early_stop"]), "NX_early_stop"
                else: level, rule = ref * (1 + NX["stop"]), "NX_stop"
                if c <= level: pending = ("all", rule); continue
                if not st["nx_took"] and c >= ref * (1 + NX["take"]):
                    st["nx_took"] = True; pending = (rem * NX["take_share"], "NX_take"); continue
            if carry_day and t < X["morning_minute"]: continue
            c = b[4]; peak = max(peak, c); g = c / basis - 1
            stall = sd.ok and t - sd.last_ext[min(t, 389)] >= X["stall_min"]
            rsd = sd.ok and (sd.rs[min(t, 389)] or 0) <= X["rs_drop"]
            if carry_day and k == 1 and "morning" not in st:
                st["morning"] = True
                gap = bet * (sd.open / sd.prev_close - 1) * 100 if sd.ok and sd.open and sd.prev_close else None
                pending = (rem * X["gap_sell_share"], "morning_gap_keep") if gap is not None and gap >= X["gap_keep"] else ("all", "morning_gap_against")
                continue
            NT = X.get("night_trail")  # carried days, after the morning sale: the rest out `NT` under the option's high since then
            if NT and carry_day and st.get("morning"):
                st["npeak"] = max(st.get("npeak", c), c)
                if c <= st["npeak"] * (1 - NT): pending = ("all", "N_trail"); continue
            NY = X.get("night_y")  # big carried winners only (night_y.py): a stop from 17:00, a trail under the high since the buy
            if NY and carry_day and t < X["eod_minute"]:
                first = next(s for s in steps if s[2] == "carry")[4] / cost - 1
                if first >= NY["min_first"]:
                    ref = next(s[4] for s in reversed(steps) if s[2] == "carry")
                    if NY.get("stop_ref") is not None and t >= NY["from"] and c <= ref * (1 + NY["stop_ref"]):
                        pending = ("all", "Y_stop"); continue
                    if NY.get("stop_cost") is not None and t >= NY["from"] and g <= NY["stop_cost"]:
                        pending = ("all", "Y_stop"); continue
                    if NY.get("trail") and st.get("morning") and c <= peak * (1 - NY["trail"]):
                        pending = ("all", "Y_trail"); continue
            if d == exp and t >= X["expiry_last_minute"]: pending = ("all", "expiry_day"); continue
            if t >= X["eod_minute"] and not eod_done:
                eod_done = True
                dte = (dt.date.fromisoformat(exp) - dt.date.fromisoformat(d)).days
                rp = sd.range_pos[min(t, 389)] if sd.ok else None
                fri = dt.date.fromisoformat(d).weekday() == 4
                # carry_force_first: the first night is held whatever the gain (retry_roll.py's roll before the night, 2026-10-27)
                first = bool(X.get("carry_force_first")) and k == 0
                need, tag = X["carry_min_gain"], ""
                CS = X.get("carry_strength")  # night_strength.py (the user, 2026-10-28): the gain needed to hold by the stock's
                # strength at 15:50: weak (t <= weak_t or D2 < weak_d) -> weak_gain, else strong (t >= strong_t or D2 >=
                # strong_d) -> strong_gain, else carry_min_gain. t = the day's t vs SPY x beta, D2 = the excess on SPY's bad
                # minutes of the last 30, in S30 units (defence_signals.py); both on the bet's side
                if CS and sd.ok and sd.beta is not None:
                    from levels import ctx
                    cx = ctx(und, d); spy_ = series(day("SPY", d))[0]; tm = min(t, 389)
                    n_ = s1 = s2 = d2 = 0.0
                    for m_ in range(1, tm + 1):
                        if sd.c[m_] and sd.c[m_ - 1] and spy_[m_] and spy_[m_ - 1]:
                            rq = spy_[m_] / spy_[m_ - 1] - 1; x_ = (sd.c[m_] / sd.c[m_ - 1] - 1) - sd.beta * rq
                            n_ += 1; s1 += x_; s2 += x_ * x_
                            if m_ > tm - 30 and bet * rq < 0 and cx and cx["sd"]: d2 += bet * x_ / cx["sd"]
                    var_ = max(s2 / n_ - (s1 / n_) ** 2, 0.0) if n_ else 0.0
                    ts = bet * (s1 / n_) / math.sqrt(var_) * math.sqrt(n_) if var_ > 0 else 0.0
                    if ts <= CS["weak_t"] or d2 < CS["weak_d"]: need, tag = CS["weak_gain"], "_weak"
                    elif ts >= CS["strong_t"] or d2 >= CS["strong_d"]: need, tag = CS["strong_gain"], "_strong"
                    else: tag = "_mid"
                good = g >= need and (rp or 0) >= X["carry_range_pos"]
                if (first or good) and dte >= X["carry_min_dte"] and not (fri and X["carry_no_friday"]) and k + 1 < len(dates) and k < X.get("carry_max_days", 99):
                    N2 = X.get("night2_keep")  # night2.py (the user, 2026-10-28): from the second night on, only this share of what is left is held
                    if N2 is not None and k >= 1 and N2 < 1:
                        q = rem * (1 - N2); rem -= q
                        steps.append((d, t, "sell", round(q, 4), round(max(mid(b) * (1 - SH), 0.01), 4), "N2_trim"))
                    CY = X.get("carry_spy")  # {window, against, keep}, spy_rules.py (the user, 2026-10-29: "take edge only there"): when
                    # SPY moved `against` or more against the bet over the last `window` minutes, hold only `keep` of the position tonight
                    if CY:
                        spy_ = series(day("SPY", d))[0]; a_, b_ = spy_[max(0, min(t, 389) - CY["window"])], spy_[min(t, 389)]
                        if a_ and b_ and bet * (b_ / a_ - 1) <= -CY["against"]:
                            q = rem * (1 - CY["keep"])
                            if q > 1e-9:
                                rem -= q
                                steps.append((d, t, "sell", round(q, 4), round(max(mid(b) * (1 - SH), 0.01), 4), "Y_spy_close"))
                            if rem <= 1e-9: return cost, steps, ""
                    steps.append((d, t, "carry", round(rem, 4), round(c, 4), "eod_carry" + tag))
                else:
                    pending = ("all", "eod_close" + tag)
                continue
            if t >= X["eod_minute"]: continue
            if g <= X["floor"]: pending = ("all", "L3_floor"); continue
            SG = X.get("stock_trail")  # {k, early_min, early_k}: the Volume bot's exit as a stop, the entry day (user, 2026-10-26):
            # out once the stock gives back k x S30 from its best since the entry; the first early_min minutes use early_k
            # instead (None: no such stop then)
            if SG and k == 0 and sd.ok:
                if "sg" not in st:
                    from levels import ctx
                    cx = ctx(und, d)
                    st["sg"] = [cx["sd"] if cx else None, sd.c[minute]]
                unit, best = st["sg"]; px = sd.c[min(t, 389)]
                if unit and px and best:
                    best = max(best, px) if bet > 0 else min(best, px); st["sg"][1] = best
                    kk = SG.get("early_k") if t - minute < SG.get("early_min", 0) else SG["k"]
                    losing = g < 0 or not SG.get("only_losing")  # only_losing: a stop for losers, winners keep the bot's own exits
                    if kk is not None and losing and bet * (px / best - 1) <= -kk * unit: pending = ("all", "S_trail"); continue
            LS = X.get("level_stop")  # {buffer, nth}: the support (a call) / resistance (a put) behind the entry broken, the entry day
            # (the user, 2026-10-27: "exit by the moving of the stock ... the support and resistance approach to stop"): the nth
            # nearest levels.py level behind the entry price at the entry minute; out at a close `buffer` x S30 beyond it
            if LS and k == 0 and sd.ok:
                if "ls" not in st:
                    from levels import ctx, levels_at
                    cx = ctx(und, d); p0 = sd.c[minute]; st["ls"] = None
                    if cx and p0:
                        behind = sorted((v for v in levels_at(cx, minute).values() if v and bet * (p0 - v) > 0), key=lambda v: bet * (p0 - v))
                        n = LS.get("nth", 1)
                        if len(behind) >= n: st["ls"] = (behind[n - 1], cx["sd"] * p0)
                px = sd.c[min(t, 389)]
                if st["ls"] and px and bet * (st["ls"][0] - px) >= LS["buffer"] * st["ls"][1]: pending = ("all", "S_level"); continue
            Z = X.get("stall_rs")  # {hours, gain, rs}: the option never up `gain` since the entry, `hours` on (user, 2026-10-24)
            if Z and k == 0 and sd.ok and t - minute >= Z["hours"] * 60 and peak / cost - 1 < Z["gain"]:
                bad = True  # with rs: the stock's move vs SPY x beta since the entry ("entry") or over the last hour ("hour") is against us
                if Z.get("rs"):
                    tt = min(t, 389); ref = minute if Z["rs"] == "entry" else max(minute, tt - 60)
                    s0, s1, y0, y1 = sd.c[ref], sd.c[tt], spyc[ref], spyc[tt]
                    bad = bool(s0 and s1 and y0 and y1) and bet * ((s1 / s0 - 1) - (sd.beta or 1.0) * (y1 / y0 - 1)) <= 0
                if bad: pending = ("all", "Z_stall"); continue
            ST = X.get("still")  # {window, k, under}: the stock's own range over the last `window` minutes under k x its usual move (user, 2026-10-24)
            if ST and k == 0 and sd.ok and t - minute >= ST["window"] and (ST.get("under") is None or peak / cost - 1 < ST["under"]):
                if "still" not in st:
                    from levels import ctx
                    cx = ctx(und, d); st["still"] = (cx["sd"] if cx else None, {b[0]: b for b in day(und, d)})
                unit, sbars = st["still"]
                if unit:
                    tt = min(t, 389); win = [sbars[m_] for m_ in range(tt - ST["window"] + 1, tt + 1) if m_ in sbars]
                    if win and (max(b[2] for b in win) - min(b[3] for b in win)) / win[-1][4] < ST["k"] * unit * (ST["window"] / 30) ** 0.5:
                        pending = ("all", "Q_still"); continue
            AS = X.get("alert_silence")  # {min}: nothing happened on the stock since the entry (user, 2026-10-25)
            if AS and k == 0 and t - minute >= AS["min"] and not st.get("as_done"):
                st["as_done"] = True
                from rvol_alert import alerts_for
                al = alerts_for(und, d, cal)
                if al is not None and not any(al[q] for q in range(minute + 1, min(t, 389) + 1)):
                    pending = ("all", "A_silence"); continue
            VF = X.get("vol_fade")  # {min, until}: the alert-route entry whose day volume stops building (user, 2026-10-24)
            if VF and k == 0 and not st.get("vf_off"):
                if "vf" not in st: st["vf"] = rvol_series(und, d, cal)
                rv = st["vf"]; tt = min(t, 389)
                if not rv or rv[minute] is None or rv[minute] >= VF["until"]: st["vf_off"] = True
                elif rv[tt] is not None and rv[tt] >= VF["until"]: st["vf_off"] = True
                elif tt - minute >= VF["min"] and rv[tt] is not None and rv[tt - VF["min"]] is not None and rv[tt] < rv[tt - VF["min"]]:
                    pending = ("all", "V_fade"); continue
            SX = X.get("stall_exit")  # {arm, min, giveback?, vol?}: the move is over -> out
            if SX and sd.ok and peak / cost - 1 >= SX["arm"]:
                tt = min(t, 389)
                if c >= peak: st["peak_t"] = (k, tt)
                stalled = tt - sd.last_ext[tt] >= SX["min"] if st.get("peak_t", (k, tt))[0] == k else True
                given = c <= peak * (1 - SX.get("giveback", 0.0))
                faded = True
                if SX.get("vol") and st.get("peak_t") and st["peak_t"][0] == k:
                    vv = series(day(und, d))[3]; pt = st["peak_t"][1]
                    ref = sum(vv[max(0, pt - 14):pt + 1]); now = sum(vv[max(0, tt - 14):tt + 1])
                    faded = ref > 0 and now < SX["vol"] * ref
                below = g < SX.get("below", 1e9)  # "below": only while under this gain (not going to be held overnight)
                if stalled and given and faded and below: pending = ("all", "X_stall"); continue
            LK = X.get("locks")  # step locks [[arm, floor], ...]: once the option has been up `arm`, sell all at `floor`
            if LK:
                pg = peak / cost - 1
                fl = max((f for arm, f in LK if pg >= arm), default=None)
                if fl is not None and g <= fl: pending = ("all", "K_lock"); continue
            TS = X.get("time_stop")  # {min, need}: at `min` minutes after the entry, out unless up `need`
            if TS and k == 0 and not st.get("ts_done") and t - minute >= TS["min"]:
                st["ts_done"] = True
                if g < TS["need"]: pending = ("all", "T_stop"); continue
            G = X.get("guard")  # give-back guard: once the option has been up `arm`, protect the gain (every day held;
            # day0: the entry day only, the overnight hold untouched; exit_tests.py, the user 2026-10-27)
            if G and (not G.get("day0") or k == 0) and peak / cost - 1 >= G["arm"]:
                if "floor" in G and g <= G["floor"]: pending = ("all", "G_floor"); continue
                if "trail" in G and c <= peak * (1 - G["trail"]): pending = ("all", "G_trail"); continue
            SC = X.get("spy_cut")  # {arm, drop, share}, spy_rules.py (the user, 2026-10-29: "cutting some from the big winners when
            # we see the spy goes down more than -.5%"): once the option was up `arm`, when SPY falls `drop` against the bet from its
            # best since then (any day held, gaps included), sell `share` of what is left, once
            if SC and not st.get("sc_done") and peak / cost - 1 >= SC["arm"]:
                spy_ = st.setdefault(("spy", d), series(day("SPY", d))[0])[min(t, 389)]
                if spy_:
                    ref = st.get("sc_ref")
                    if ref is None or bet * (spy_ - ref) > 0: st["sc_ref"] = ref = spy_
                    if bet * (spy_ / ref - 1) <= -SC["drop"]:
                        st["sc_done"] = True; pending = (rem * SC["share"], "S_spy_cut"); continue
            NC = X.get("nocarry_trail")  # {arm, trail}, expiry_rules.py (the user, 2026-10-29: "if this is the last trading
            # day (can't overnight) try to cut winnings during the day"): on a day the position cannot be held tonight
            # (under carry_min_dte days to expiry), once up `arm` over the cost, all out `trail` under the option's high
            if NC and peak / cost - 1 >= NC["arm"] and (dt.date.fromisoformat(exp) - dt.date.fromisoformat(d)).days < X["carry_min_dte"]:
                if c <= peak * (1 - NC["trail"]): pending = ("all", "NC_trail"); continue
            BT_ = X.get("big_trail")  # {arm, k}: once the option was up `arm` (any day held), out when the stock gives back k x S30
            # from its best since then (the user, 2026-10-27: "from some gain we should start to take profits")
            if BT_ and sd.ok and peak / cost - 1 >= BT_["arm"]:
                if "bt" not in st:
                    from levels import ctx
                    cx = ctx(und, dates[0]); st["bt"] = [cx["sd"] if cx else None, None]
                px = sd.c[min(t, 389)]
                if st["bt"][0] and px:
                    best = st["bt"][1] or px
                    st["bt"][1] = max(best, px) if bet > 0 else min(best, px)
                    if bet * (px / st["bt"][1] - 1) <= -BT_["k"] * st["bt"][0]: pending = ("all", "S_bigtrail"); continue
            R_ = X.get("roll")
            if R_ and not st.get("rolled") and k == 0 and t - minute <= R_["within"] and roll_hit(R_, g, sd, t, minute, sym, bet):
                st["rolled"] = True; pending = (rem * R_["share"], "R_roll"); continue
            if R_ and st.get("rolled") and g >= R_["rest_take"]: pending = ("all", "R_take"); continue
            TH = X.get("thesis")  # {s30, bar, t}: the entry's thesis broken on the stock itself (user, 2026-10-24)
            if TH and k == 0 and sd.ok and not hold:
                if "th" not in st:
                    from levels import ctx
                    cx = ctx(und, d)
                    unit = cx["sd"] * sd.c[minute] if cx and sd.c[minute] else None
                    sb = next((b for b in day(und, d) if b[0] == minute), None)
                    tser = None
                    if TH.get("t") is not None and sd.beta is not None:
                        spy_ = series(day("SPY", d))[0]; tser = [None] * 390; n_ = s1 = s2 = 0.0
                        for m_ in range(1, 390):
                            if sd.c[m_] and sd.c[m_ - 1] and spy_[m_] and spy_[m_ - 1]:
                                x_ = (sd.c[m_] / sd.c[m_ - 1] - 1) - sd.beta * (spy_[m_] / spy_[m_ - 1] - 1)
                                n_ += 1; s1 += x_; s2 += x_ * x_
                            if n_ >= 5:
                                mu_ = s1 / n_; var_ = max(s2 / n_ - mu_ * mu_, 0.0)
                                tser[m_] = mu_ / math.sqrt(var_) * math.sqrt(n_) if var_ > 0 else 0.0
                    st["th"] = (unit, sb, tser)
                unit, sb, tser = st["th"]; tt = min(t, 389); px = sd.c[tt]
                if px:
                    if TH.get("s30") and unit and bet * (px - sd.c[minute]) <= -TH["s30"] * unit: pending = ("all", "T_s30"); continue
                    if TH.get("bar") and sb and (px < sb[3] if bet > 0 else px > sb[2]): pending = ("all", "T_bar"); continue
                    if TH.get("t") is not None and tser and tser[tt] is not None and bet * tser[tt] <= TH["t"]: pending = ("all", "T_tstat"); continue
            SS = X.get("stock_stages")  # the user 2026-10-31 ("multiple exit half than exit full phases. exit half than
            # bring back when it looks good again"), the entry day, on the stock's move from the signal price in S30 units:
            # {half: 0.5, share: 0.5, full: 1.0, back: 0.0, until: 330, repeat: false}: `share` of what is held out once the
            # stock is `half` S30 against; all out at `full` against; with `back`, the part sold bought back once the stock
            # is `back` S30 on our side of the signal price again (before minute `until`); `repeat`: the half can fire again
            # after a buy back
            if SS and k == 0 and sd.ok and not hold:
                if "ss" not in st:
                    from levels import ctx
                    cx = ctx(und, d); p0 = sd.c[minute]
                    st["ss"] = (cx["sd"] * p0 if cx and cx["sd"] and p0 else None, p0)
                unit, p0 = st["ss"]; px = sd.c[min(t, 389)]
                if unit and px:
                    mv = bet * (px - p0) / unit
                    if SS.get("full") is not None and mv <= -SS["full"]: pending = ("all", "T_full"); continue
                    if SS.get("half") is not None and not st.get("ss_half") and mv <= -SS["half"]:
                        st["ss_half"] = True; st["rb_q"] = rem * SS.get("share", 0.5); st["rebought"] = False
                        pending = (st["rb_q"], "T_half"); continue
                    if SS.get("back") is not None and st.get("ss_half") and not st.get("rebought") and not st.get("rb_pending") \
                            and mv >= SS["back"] and t <= SS.get("until", 330):
                        st["rb_pending"] = True
                        if SS.get("repeat"): st["ss_half"] = False
                        continue
            DF = X.get("defence")  # {window, out}: the stock stops holding up on the market's bad minutes
            if DF and k == 0 and sd.ok and sd.beta is not None and t - minute >= DF["window"]:
                if "df" not in st:
                    from levels import ctx
                    cx = ctx(und, d); spy_ = series(day("SPY", d))[0]; ex = [0.0] * 390
                    if cx and cx["sd"]:
                        for m_ in range(1, 390):
                            if sd.c[m_] and sd.c[m_ - 1] and spy_[m_] and spy_[m_ - 1]:
                                rp = spy_[m_] / spy_[m_ - 1] - 1
                                if bet * rp < 0: ex[m_] = bet * ((sd.c[m_] / sd.c[m_ - 1] - 1) - sd.beta * rp) / cx["sd"]
                    st["df"] = ex if cx and cx["sd"] else None
                tt = min(t, 389)
                if st["df"] and sum(st["df"][tt - DF["window"] + 1:tt + 1]) <= DF["out"]: pending = ("all", "DF_defence"); continue
            if X.get("user_stop") and sd.ok and k == 0 and not hold:
                U = X["user_stop"]; tt = min(t, 389)
                if st.get("sp0") is None: st["sp0"] = sd.c[minute]
                against = sd.c[tt] is not None and st["sp0"] and bet * (sd.c[tt] - st["sp0"]) < 0
                E = U.get("every")  # every minute in [from, to] after the entry: the first one against sells `share`, once
                hit_e = E and ((g <= E["opt"]) if "opt" in E else against)  # "opt": the option at that gain or worse, else the stock against
                if E and not st.get("every_done") and E["from"] <= t - minute <= E["to"] and hit_e:
                    st["every_done"] = True; pending = (rem * E["share"], "U_every"); continue
                if "checks" in U:  # checkpoints [[minutes after entry, share of what is left], ...], each once
                    done = st.setdefault("checks_done", set())
                    hit = next((i for i, (mins, _) in enumerate(U["checks"]) if i not in done and t - minute >= mins), None)
                    if hit is not None:
                        # opt_below (e.g. -0.10): the check also needs the option at that gain or worse (user, 2026-10-24);
                        # opt_wait: a check not met stays armed until both hold, instead of passing once
                        opt_ok = U.get("opt_below") is None or g <= U["opt_below"]
                        forced = U.get("rest_after_half") and hit > 0 and st.get("half_q")  # sell the rest even with the stock back (user, 2026-10-24)
                        if (against and opt_ok) or forced:
                            done.add(hit)
                            share = U["checks"][hit][1]
                            pending = ("all" if share >= 1 else rem * share, f"U_check{U['checks'][hit][0]}"); continue
                        if not U.get("opt_wait"): done.add(hit)
                elif not st.get("half") and U["check_from"] <= t - minute <= U["check_to"] and against:
                    st["half"] = True; pending = (rem * U["share"], "U_half"); continue
                EO = X.get("early_out")
                out_now = EO["out"] if EO and t - minute < EO["min"] else uout  # a wider stop right after the entry (user, 2026-10-24)
                RB = X.get("rebuy")
                if RB and st.get("half_q") and not st.get("rebought") and not st.get("rb_pending") and t <= RB.get("until", 330) and sd.c[tt] is not None:
                    back = (t - minute >= 20 and not against) if RB["mode"] == "at20" else bet * (sd.c[tt] - st["sp0"]) >= RB.get("off", 0) and sd.c[tt] != st["sp0"]
                    # only when the stock is stronger (refill.py, the user 2026-10-29: "double it if we have stronger
                    # parameters"): its t vs SPY x beta now at least `min_t`, and / or `t_over` above its t at the entry
                    if back and (RB.get("min_t") is not None or RB.get("t_over") is not None):
                        ts_ = st["th"][2] if st.get("th") else None
                        tn = bet * ts_[tt] if ts_ and ts_[tt] is not None else None
                        t0 = bet * ts_[minute] if ts_ and ts_[minute] is not None else None
                        back = tn is not None and (RB.get("min_t") is None or tn >= RB["min_t"])
                        back = back and (RB.get("t_over") is None or (t0 is not None and tn >= t0 + RB["t_over"]))
                    if back: st["rb_pending"] = True; continue
                AH = X.get("after_half")  # the rest after the +10 half: a tighter stop (user, 2026-10-24)
                if AH and st.get("half_q") and not early:
                    lvl = st["half_px"] / basis - 1 if AH.get("out") == "half_px" else AH.get("out")
                    need = against or not AH.get("need_against", True)
                    if lvl is not None and g <= lvl and need: pending = ("all", "U_rest"); continue
                    if AH.get("stock") and t - minute > 20 and against: pending = ("all", "U_rest"); continue
                if g <= out_now and against and not early: pending = ("all", "U_out"); continue
            if X.get("user_stop") and sd.ok and k > 0 and g <= uout:
                pending = ("all", "U_out"); continue
            if X.get("stock_stop") and sd.ok and k == 0 and t > minute:
                tt = min(t, 389); px = sd.c[tt]
                if X["stock_stop"] == "vwap" and not sd.vwap_ok[tt]: pending = ("all", "S_vwap"); continue
                if X["stock_stop"] == "prev" and px is not None and sd.prev_hi and (px <= sd.prev_hi if bet > 0 else px >= sd.prev_lo):
                    pending = ("all", "S_prev"); continue
            held = t - minute if k == 0 else 999
            st["below"] = st.get("below", 0) + 1 if g <= X["cut1"] else 0
            if not st["cut1"] and st["below"] >= X["cut1_confirm"] and held >= X["min_hold"]:
                st["cut1"] = True; pending = (rem * X["cut1_share"], "L1_cut"); continue
            if X["l2_on"] and st["cut1"] and g < 0 and (stall or rsd): pending = ("all", "L2_stall" if stall else "L2_rs_drop"); continue
            if g >= X["win_arm"]: st["armed"] = True
            if st["armed"] and not st["t1"] and g <= 0: pending = ("all", "W1_even"); continue
            if st["plan"] is None and X["takes"] and g >= X["takes"][0][0]:
                fast = X["fast_minutes"] is not None and k == 0 and t - minute <= X["fast_minutes"]
                st["plan"] = X["fast_takes"] if fast else X["takes"]
                st["fast"] = fast
            if st["plan"] is not None and st["k"] < len(st["plan"]) and g >= st["plan"][st["k"]][0]:
                gain, share = st["plan"][st["k"]]; st["k"] += 1; st["t1"] = True
                pending = (share, f"W2_take{int(gain * 100)}{'_fast' if st.get('fast') else ''}"); continue
            if st["t1"] and (c <= peak * (1 - X["trail"]) or (sd.ok and t - sd.last_ext[min(t, 389)] >= X["runner_stall_min"])):
                pending = ("all", "W4_runner"); continue
        if cost is None: return None, [], "no_fill"
        if pending and pending[0] == "all" and bars:  # decided on the day's last bar: fill at it
            steps.append((d, bars[-1][0], "sell", round(rem, 4), round(max(bars[-1][4] * (1 - SH), 0.01), 4), pending[1] + "_late"))
            return cost, steps, "late_fill"
        if not (steps and steps[-1][2] == "carry"):
            if bars and rem > 1e-9:
                steps.append((d, bars[-1][0], "sell", round(rem, 4), round(max(bars[-1][4] * (1 - SH), 0.01), 4), "day_end_forced"))
                return cost, steps, "forced"
    # past expiry with contracts left: intrinsic value at the stock's close
    sd = day(und, exp)
    k_ = float(sym[-8:]) / 1000
    val = max(0.0, bet * ((sd[-1][4] if sd else 0) - k_))
    steps.append((exp, 389, "sell", round(rem, 4), round(val, 4), "expired"))
    return cost, steps, "expired"


def cap_steps(cost, steps, pct, cap=None):
    """The steps with the overnight cap applied at a trade size of `pct` of the account: at each carry, the part worth
    more than `cap` of the account (contracts x close x 100, the account at the day's start) is sold at the close less
    the spread ("eod_cap"), and every later share is scaled down to what was kept. -> new steps (shares of the original)."""
    cap = NIGHT_CAP if cap is None else cap
    if not pct or not cap: return list(steps)
    out, f = [], 1.0
    for d, t, side, q, px, rule in steps:
        if side == "carry":
            r = q * f
            k = min(r, cap * cost / (pct * px)) if px > 0 else r
            if k < r - 1e-9:
                out.append((d, t, "sell", round(r - k, 4), round(max(px * (1 - SH), 0.01), 4), "eod_cap"))
                f *= k / r
            out.append((d, t, side, round(k, 4), px, rule))
        elif side == "sell": out.append((d, t, side, round(q * f, 4), px, rule))
        else: out.append((d, t, side, q, px, rule))
    return out


def result(cost, steps, pct=None):
    """The return on the premium after costs, at a trade size of `pct` of the account (RISK_PCT unless given; 0 = no
    overnight cap)."""
    steps = cap_steps(cost, steps, RISK_PCT if pct is None else pct)
    sold = sum(s[3] * s[4] for s in steps if s[2] == "sell")
    rebuys = [s for s in steps if s[2] == "buy" and s[5] == "rebuy"]  # rebuy: more paid in after the entry
    contracts_per_dollar = 1 / (cost * 100)
    comm = COMM * contracts_per_dollar * (1 + sum(s[3] for s in steps if s[2] == "sell") + sum(s[3] for s in rebuys))
    return (sold - sum(s[3] * s[4] for s in rebuys)) / cost - 1 - comm


def run(signals, prefix, shard=0, shards=1):
    cal = calendar()
    trades, allsteps = [], []
    for n, s in enumerate(signals):
        if n % shards != shard: continue
        m = int(s["minute"])
        if s.get("contract"):  # a given contract (his entries): no pick
            exp = s["expiry"]
            picked, why = (s["contract"], exp, float(s["contract"][-8:]) / 1000, 0.0, None, 1e9, None), None
        else:
            try: picked, why = pick(s["sym"], s["date"], m, s["right"], float(s["price"]))
            except RuntimeError: picked, why = None, "data_error"  # Alpaca kept failing for this request: count it, go on
        row = dict(s, id=n)
        if not picked:
            row.update(status=why); trades.append(row); continue
        sym, exp, k, dl, px, v30, iv = picked
        limit = None
        if LIMIT:
            lb = last_bar(day(sym, s["date"]), m, C["bar_max_age"])
            limit = lb[4] * (1 + LIMIT_PAD) if lb else None
            if limit is None:
                row.update(status="no_prices"); trades.append(row); continue
        try: cost, steps, flag = walk(s["sym"], s["date"], m, s["right"], sym, exp, cal, limit)
        except RuntimeError: cost, steps, flag = None, [], "data_error"
        row.update(contract=sym, expiry=exp, strike=k, delta=round(dl, 3), iv=round(iv, 3) if iv else "", signal_price=px, vol30=v30,
                   dte=(dt.date.fromisoformat(exp) - dt.date.fromisoformat(s["date"])).days)
        if cost is None:
            row.update(status=flag); trades.append(row); continue
        last = [x for x in steps if x[2] == "sell"][-1]
        row.update(status="ok", flag=flag, entry=round(cost, 4), ret=round(result(cost, steps), 4),
                   carried=int(any(x[2] == "carry" for x in steps)), exit_date=last[0], exit_minute=last[1],
                   exit_rule=last[5], rules="|".join(x[5] for x in steps[1:]))
        trades.append(row)
        for x in steps: allsteps.append(dict(id=n, contract=sym, date=x[0], minute=x[1], side=x[2], share=x[3], price=x[4], rule=x[5]))
        if n % 100 == 0: print(n, s["date"], s["sym"], row.get("status"), flush=True)
    keys = list(dict.fromkeys(k for r in trades for k in r))
    with open(f"{prefix}_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(trades)
    with open(f"{prefix}_steps.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=["id", "contract", "date", "minute", "side", "share", "price", "rule"]); w.writeheader(); w.writerows(allsteps)
    ok = [t for t in trades if t["status"] == "ok"]
    print(len(trades), "signals,", len(ok), "trades ->", f"{prefix}_trades.csv")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "signals.csv")
    prefix = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA, "bot")
    shard, shards = map(int, sys.argv[3].split("/")) if len(sys.argv) > 3 else (0, 1)
    run(list(csv.DictReader(open(src))), f"{prefix}.{shard}" if shards > 1 else prefix, shard, shards)
