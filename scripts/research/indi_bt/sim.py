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
  G guard (guard {arm, floor | trail}): once the option has been up `arm` (peak close vs the entry fill),
               sell all when the gain falls to `floor`, or the price falls `trail` from its peak
  N night trail (night_trail x): on a carried day, after the morning rule kept a part, sell it when the option
               closes x under its highest close since the morning
  U your stop (user_stop {every: {from, to, share}} sells `share` at the first minute in the window the stock is
               against the entry, once; then {checks: [[10, 0.5], [20, 1.0]], out} or {check_from, check_to, share, out}):
               at each checkpoint (minutes after the entry, once), the stock on the wrong side of the entry
               price -> sell that share of what is left. Older form: 10-20 minutes after the entry, the stock
               on the wrong side of the entry price -> sell `share` (once); option at `out` (e.g. -35%)
               with the stock on the wrong side of the entry price -> sell all
  S stock stop (stock_stop "vwap" / "prev", entry day): the stock closes back on the wrong side of
               VWAP, or back inside yesterday's range                    -> sell all
  EOD 15:50    carry only if g >= carry_min_gain, stock at >= carry_range_pos of the day range,
               not Friday, >= carry_min_dte days to expiry -> else sell all
  carry_max_days  nights a position may be carried (default: no limit)
  morning      after a carry, at 09:30 + morning_minute: gap in the bet direction >= gap_keep %
               -> sell gap_sell_share, keep the rest under the rules; otherwise sell all
  expiry day   sell all at 09:30 + expiry_last_minute
Each trade's result is a return on the premium paid (`ret`, after costs); sizing is in report.py.

  python3 sim.py [signals.csv] [out prefix] [shard/shards]  -> <prefix>_trades.csv, <prefix>_steps.csv
  (with a shard, only every shards-th signal from `shard`, written to <prefix>.<shard>_*.csv;
  report.py reads all shards of a prefix)
"""
import csv, datetime as dt, json, os, sys
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


def roll_hit(R_, g, sd, t, minute, sym, bet):
    """The roll trigger: the option up R_["gain"], or with R_["near"] the stock has come close to the strike: what is
    left of the way from the entry price to the strike is at most `near` of it (0 = at the money)."""
    if "near" not in R_: return g >= R_["gain"]
    if not sd.ok: return False
    s0, s = sd.c[minute], sd.c[min(t, 389)]
    k = float(sym[-8:]) / 1000
    if not s0 or not s or bet * (k - s0) <= 0: return False
    return bet * (k - s) / (bet * (k - s0)) <= R_["near"]


def walk(und, date, minute, right, sym, exp, cal, limit=None):
    """Walks one contract from the signal minute to the last sale. -> (entry, steps, flags)."""
    bet = 1 if right == "C" else -1
    i0 = cal.index(date)
    dates = [d for d in cal[i0:] if d <= exp]
    fetch_bars("options", [sym], date, exp)
    steps, rem, cost, peak = [], 1.0, None, None
    if FILL in ("close", "mid") and limit is None:  # BT_FILL: buy on the signal bar itself, at its close ("close") or its middle ("mid", looks ahead)
        b0 = last_bar(day(sym, date), minute, C["bar_max_age"])
        if b0:
            cost = (b0[4] if FILL == "close" else mid(b0)) * (1 + SH); peak = b0[4]
            steps.append((date, minute, "buy", 1.0, round(cost, 4), f"entry_{FILL}"))
    st = dict(cut1=False, armed=False, t1=False, plan=None, k=0)
    pending = None  # (share of original or 'all', rule)
    for k, d in enumerate(dates):
        bars = day(sym, d)
        sd = Day(und, d, bet, cal, cal.index(d))
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
                peak = b[4]
                steps.append((d, t, "buy", 1.0, round(cost, 4), "entry_limit" if limit is not None else "entry"))
                continue
            if pending:
                share, rule = pending
                q = rem if share == "all" else min(rem, share)
                rem -= q
                steps.append((d, t, "sell", round(q, 4), round(max(mid(b) * (1 - SH), 0.01), 4), rule))
                pending = None
                if rem <= 1e-9: return cost, steps, ""
            if carry_day and t < X["morning_minute"]: continue
            c = b[4]; peak = max(peak, c); g = c / cost - 1
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
            if d == exp and t >= X["expiry_last_minute"]: pending = ("all", "expiry_day"); continue
            if t >= X["eod_minute"] and not eod_done:
                eod_done = True
                dte = (dt.date.fromisoformat(exp) - dt.date.fromisoformat(d)).days
                rp = sd.range_pos[min(t, 389)] if sd.ok else None
                fri = dt.date.fromisoformat(d).weekday() == 4
                if g >= X["carry_min_gain"] and (rp or 0) >= X["carry_range_pos"] and dte >= X["carry_min_dte"] and not (fri and X["carry_no_friday"]) and k + 1 < len(dates) and k < X.get("carry_max_days", 99):
                    steps.append((d, t, "carry", round(rem, 4), round(c, 4), "eod_carry"))
                else:
                    pending = ("all", "eod_close")
                continue
            if t >= X["eod_minute"]: continue
            if g <= X["floor"]: pending = ("all", "L3_floor"); continue
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
            G = X.get("guard")  # give-back guard: once the option has been up `arm`, protect the gain (every day held)
            if G and peak / cost - 1 >= G["arm"]:
                if "floor" in G and g <= G["floor"]: pending = ("all", "G_floor"); continue
                if "trail" in G and c <= peak * (1 - G["trail"]): pending = ("all", "G_trail"); continue
            R_ = X.get("roll")
            if R_ and not st.get("rolled") and k == 0 and t - minute <= R_["within"] and roll_hit(R_, g, sd, t, minute, sym, bet):
                st["rolled"] = True; pending = (rem * R_["share"], "R_roll"); continue
            if R_ and st.get("rolled") and g >= R_["rest_take"]: pending = ("all", "R_take"); continue
            if X.get("user_stop") and sd.ok and k == 0:
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
                        done.add(hit)
                        if against:
                            share = U["checks"][hit][1]
                            pending = ("all" if share >= 1 else rem * share, f"U_check{U['checks'][hit][0]}"); continue
                elif not st.get("half") and U["check_from"] <= t - minute <= U["check_to"] and against:
                    st["half"] = True; pending = (rem * U["share"], "U_half"); continue
                if g <= U["out"] and against: pending = ("all", "U_out"); continue
            if X.get("user_stop") and sd.ok and k > 0 and g <= X["user_stop"]["out"]:
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


def result(cost, steps):
    sold = sum(s[3] * s[4] for s in steps if s[2] == "sell")
    contracts_per_dollar = 1 / (cost * 100)
    comm = COMM * contracts_per_dollar * (1 + sum(s[3] for s in steps if s[2] == "sell"))
    return sold / cost - 1 - comm


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
