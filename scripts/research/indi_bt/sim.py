"""Trade simulation: for each signal, pick the contract and walk it minute by minute to the exit.

Contract   nearest expiry dte_min..dte_max calendar days out; the out-of-the-money strike whose delta
           (Black-Scholes, implied vol of the last bar price within bar_max_age minutes) is closest to
           `delta`; skipped when that contract has < min_vol30 contracts in the last 30 minutes or costs
           < min_price. Never falls back to another contract.
Fills      decided on one option bar, filled on the next bar of that contract at the bar middle
           (high+low)/2 + spread_half (buy) or - spread_half (sell), plus commission per contract.
Exits      (gain g = option bar close / entry fill - 1, checked on every option bar)
  L3 floor     g <= floor                                  -> sell all
  L1 first cut g <= cut1, once                             -> sell cut1_share of what is left
  L2 stall     after L1, g < 0 and the stock made no new extreme for stall_min minutes
               or fell rs_drop % vs SPY x beta in 5 minutes -> sell all
  W1 even      g reached win_arm, then g <= 0              -> sell all
  W2/W3 takes  g >= take1 / take2                          -> sell take_share of the original
  W4 runner    after W2: 'trail' off the peak price, or no new stock extreme for runner_stall_min
               minutes                                     -> sell all
  EOD 15:50    carry only if g >= carry_min_gain, stock at >= carry_range_pos of the day range,
               not Friday, >= carry_min_dte days to expiry -> else sell all
  morning      after a carry, at 09:30 + morning_minute: gap in the bet direction >= gap_keep %
               -> sell gap_sell_share, keep the rest under the rules; otherwise sell all
  expiry day   sell all at 09:30 + expiry_last_minute
Each trade's result is a return on the premium paid (`ret`, after costs); sizing is in report.py.

  python3 sim.py [signals.csv] [out prefix]  -> <prefix>_trades.csv, <prefix>_steps.csv
"""
import csv, datetime as dt, os, sys
from store import P, DATA, day, calendar, chain, expiries, fetch_bars, occ, delta, years_to_expiry
from signals import Day

C, X, SH = P["contract"], P["exit"], P["cost"]["spread_half"]
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
    """-> (symbol, expiry, strike, delta, price, vol30) or (None, reason)."""
    exp = expiry_for(und, date)
    if not exp: return None, "no_expiry"
    call = right == "C"
    ks = [k for k in chain(und, exp, right) if (spot <= k <= spot * (1 + C["otm_scan_max"]) if call else spot * (1 - C["otm_scan_max"]) <= k <= spot)]
    ks = sorted(ks, key=lambda k: abs(k - spot))[:30]
    if not ks: return None, "no_strikes"
    syms = [occ(und, exp, k, right) for k in ks]
    fetch_bars("options", syms, date, date, key=f"cand|{und}|{exp}|{right}|{date}|{ks[0]}|{ks[-1]}")
    T = years_to_expiry(date, minute, exp)
    best = None
    for k, s in zip(ks, syms):
        b = last_bar(day(s, date), minute, C["bar_max_age"])
        if not b: continue
        d = delta(b[4], spot, k, T, C["rate"], call)
        if d is None: continue
        if best is None or abs(d - C["delta"]) < abs(best[3] - C["delta"]):
            best = (s, exp, k, d, b[4], sum(x[5] for x in day(s, date) if minute - 30 < x[0] <= minute))
    if not best: return None, "no_prices"
    if best[4] < C["min_price"]: return None, "too_cheap"
    if best[5] < C["min_vol30"]: return None, "illiquid"
    return best, None


def mid(b): return (b[2] + b[3]) / 2


def walk(und, date, minute, right, sym, exp, cal):
    """Walks one contract from the signal minute to the last sale. -> (entry, steps, flags)."""
    bet = 1 if right == "C" else -1
    i0 = cal.index(date)
    dates = [d for d in cal[i0:] if d <= exp]
    fetch_bars("options", [sym], date, exp)
    steps, rem, cost, peak = [], 1.0, None, None
    st = dict(cut1=False, armed=False, t1=False, t2=False)
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
                if t > minute + 3: return None, [], "no_fill"
                cost = mid(b) * (1 + SH); peak = b[4]
                steps.append((d, t, "buy", 1.0, round(cost, 4), "entry"))
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
            if d == exp and t >= X["expiry_last_minute"]: pending = ("all", "expiry_day"); continue
            if t >= X["eod_minute"] and not eod_done:
                eod_done = True
                dte = (dt.date.fromisoformat(exp) - dt.date.fromisoformat(d)).days
                rp = sd.range_pos[min(t, 389)] if sd.ok else None
                fri = dt.date.fromisoformat(d).weekday() == 4
                if g >= X["carry_min_gain"] and (rp or 0) >= X["carry_range_pos"] and dte >= X["carry_min_dte"] and not (fri and X["carry_no_friday"]) and k + 1 < len(dates):
                    steps.append((d, t, "carry", round(rem, 4), round(c, 4), "eod_carry"))
                else:
                    pending = ("all", "eod_close")
                continue
            if t >= X["eod_minute"]: continue
            if g <= X["floor"]: pending = ("all", "L3_floor"); continue
            if not st["cut1"] and g <= X["cut1"]: st["cut1"] = True; pending = (rem * X["cut1_share"], "L1_cut"); continue
            if st["cut1"] and g < 0 and (stall or rsd): pending = ("all", "L2_stall" if stall else "L2_rs_drop"); continue
            if g >= X["win_arm"]: st["armed"] = True
            if st["armed"] and not st["t1"] and g <= 0: pending = ("all", "W1_even"); continue
            if not st["t1"] and g >= X["take1"]: st["t1"] = True; pending = (X["take_share"], "W2_take"); continue
            if st["t1"] and not st["t2"] and g >= X["take2"]: st["t2"] = True; pending = (X["take_share"], "W3_take"); continue
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


def run(signals, prefix):
    cal = calendar()
    trades, allsteps = [], []
    for n, s in enumerate(signals):
        m = int(s["minute"])
        if s.get("contract"):  # a given contract (his entries): no pick
            exp = s["expiry"]
            picked, why = (s["contract"], exp, float(s["contract"][-8:]) / 1000, 0.0, None, 1e9), None
        else:
            picked, why = pick(s["sym"], s["date"], m, s["right"], float(s["price"]))
        row = dict(s)
        if not picked:
            row.update(status=why); trades.append(row); continue
        sym, exp, k, dl, px, v30 = picked
        cost, steps, flag = walk(s["sym"], s["date"], m, s["right"], sym, exp, cal)
        row.update(contract=sym, expiry=exp, strike=k, delta=round(dl, 3), signal_price=px, vol30=v30,
                   dte=(dt.date.fromisoformat(exp) - dt.date.fromisoformat(s["date"])).days)
        if cost is None:
            row.update(status=flag); trades.append(row); continue
        last = [x for x in steps if x[2] == "sell"][-1]
        row.update(status="ok", flag=flag, entry=round(cost, 4), ret=round(result(cost, steps), 4),
                   carried=int(any(x[2] == "carry" for x in steps)), exit_date=last[0], exit_minute=last[1],
                   exit_rule=last[5], rules="|".join(x[5] for x in steps[1:]))
        trades.append(row)
        for x in steps: allsteps.append(dict(id=n, contract=sym, date=x[0], minute=x[1], side=x[2], share=x[3], price=x[4], rule=x[5]))
        if n % 50 == 0: print(n, s["date"], s["sym"], row.get("ret"), flush=True)
    keys = list(dict.fromkeys(k for r in trades for k in r))
    with open(f"{prefix}_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(trades)
    with open(f"{prefix}_steps.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(allsteps[0])); w.writeheader(); w.writerows(allsteps)
    ok = [t for t in trades if t["status"] == "ok"]
    print(len(trades), "signals,", len(ok), "trades ->", f"{prefix}_trades.csv")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "signals.csv")
    run(list(csv.DictReader(open(src))), sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA, "bot"))
