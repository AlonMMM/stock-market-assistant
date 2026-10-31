"""V2 + the failed-break sale with the exits checked every 10 seconds (the live bot since 2026-10-23), on the 10-second
bar database (data/local/bars-10s.sqlite, built by scripts/build-10s-bars.ts), against the same rules checked once a
minute (the user's question, 2026-10-24: "can we run the test with the 10s bars?").

The live bot ticks every 10 seconds: the +10 / +20 minute checks ("the stock is against the entry"), the -30% stop
(with the stock against), the failed-break sale and the 15:50 / morning / expiry rules run on every tick with the
stock's last trade and a fresh option quote. The backtest walked them once a minute, on the closed bar.

Each trade of the champion's signal files (t >= 1.8, news filter, delta 0.15) is walked three ways:
  sim     sim.walk with the bot's rules (H + NIGHT + the failed break), once a minute: the logged champion-bot result
  1-min   this script's walk at the minute's end only; it must equal `sim` (a check of the walk itself)
  10-s    this script's walk on every 10-second tick
Stock price at a tick: the close of the 10-second bar ending there (the last trade; a slot without a priced trade keeps
the price before it). Option mark at a tick: MODELED. Black-Scholes at the stock's tick price with the implied
volatility of the last closed option minute bar (at most 10 minutes old), so a tick inside minute m knows bars up to
m-1 only. At the minute's end the real bar close is used, as the 1-minute walk does; the model's error against that
close is measured and printed. A sale decided at a tick fills at the next tick's mark - 2% (the 1-minute walk: the next
bar's middle - 2%, as sim.py). The entry is sim.py's: the next bar's middle + 2%. The failed break is found on closed
minute bars in all three (the live bot's level watch reads closed bars too).
Only the database's window (one year to 2026-10-22) and its symbols; trades on other symbols are left out of all three
versions. 1% / 2% of the start-of-day account from $100,000.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs exits_10s.py [limit]   (from the repo root)
"""
import collections, csv, datetime as dt, glob, multiprocessing as mp, os, sqlite3, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import NY, bs, calendar, day, iv_delta, years_to_expiry
from signals import Day
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account, held

B = "data/local/x/bt"
TEN_DB = os.environ.get("BT_10S_DB", "data/local/bars-10s.sqlite")
CAL = calendar()
IDX = {d: i for i, d in enumerate(CAL)}
X0 = {**sim.X, **H, **NIGHT, "failed_break": True}
sim.X.clear(); sim.X.update(X0)
SH, RATE, AGE = sim.SH, sim.C["rate"], sim.C["bar_max_age"]
CHECKS, OUT, EOD, MORNING, GAP_KEEP, CARRY_MIN, MAX_NIGHTS, EXPIRY_LAST = ((10, 0.5), (20, 1.0)), -0.30, 380, 10, 0.5, 1.0, 2, 360
VERSIONS = ("sim", "1-min", "10-s")
SLOTS = 2340  # 390 minutes x 6

_ten, _tcache = None, {}


def ten_window():
    db = sqlite3.connect(f"file:{TEN_DB}?mode=ro", uri=True)
    a, z = db.execute("SELECT min(date), max(date) FROM symbol_days").fetchone()
    syms = {r[0] for r in db.execute("SELECT DISTINCT symbol FROM symbol_days")}
    db.close()
    return a, z, syms


def ticks(sym, date):
    """The stock's price at the end of each 10-second slot of the session (2340), or None when the day is not there."""
    global _ten
    k = (sym, date)
    if k in _tcache: return _tcache[k]
    if _ten is None: _ten = sqlite3.connect(f"file:{TEN_DB}?mode=ro", uri=True)
    d = dt.date.fromisoformat(date)
    a = int(dt.datetime(d.year, d.month, d.day, 9, 30, tzinfo=NY).timestamp())
    rows = _ten.execute("SELECT start, close FROM bars WHERE symbol=? AND start>=? AND start<? ORDER BY start", (sym, a, a + SLOTS * 10)).fetchall()
    out = None
    if rows:
        out = [None] * SLOTS
        for s, c in rows: out[(s - a) // 10] = c
        last = None
        for j in range(SLOTS):
            if out[j] is None: out[j] = last
            else: last = out[j]
    if len(_tcache) > 3000: _tcache.clear()
    _tcache[k] = out
    return out


def walk(t, ten):
    """One trade under the bot's rules. ten: every 10-second tick (True) or the minute's end only (False).
    -> (cost, steps, errors): steps as sim.py's (date, minute, side, share, price, rule); errors = the option model's
    relative errors against the real minute closes (10-s only)."""
    und, date, m0, right, sym, exp = t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"]
    bet, call = (1, True) if right == "C" else (-1, False)
    strike = float(sym[-8:]) / 1000
    dates = [d for d in CAL[IDX[date]:] if d <= exp]
    b1 = next((b for b in day(sym, date) if b[0] > m0), None)
    if b1 is None or b1[0] > m0 + 3: return None, [], []
    cost = sim.mid(b1) * (1 + SH)
    steps, rem, errs = [(date, b1[0], "buy", 1.0, round(cost, 4), "entry")], 1.0, []
    sd0 = Day(und, date, bet, CAL, IDX[date])
    entry_stock = sd0.c[m0] if sd0.ok else None
    fb = sim.failed_break_minute(und, date, m0, bet)
    checks_done, nights = set(), 0

    def sell(share, rule, price, d, when):
        nonlocal rem
        q = rem if share >= 1 else min(rem, rem * share)
        rem -= q
        steps.append((d, when, "sell", round(q, 4), round(max(price * (1 - SH), 0.01), 4), rule))

    for kday, d in enumerate(dates):
        obars = day(sym, d)
        if not obars: continue
        ob = {b[0]: b for b in obars}
        sd = sd0 if kday == 0 else Day(und, d, bet, CAL, IDX[d])
        sc = sd.c if sd.ok else [None] * 390
        tk = ticks(und, d) if ten else None
        carried, decided, morning_done, pending = kday > 0, False, False, None
        iv_at = {}  # minute -> implied volatility of the last closed option bar before it (None: no anchor)
        for m in range(b1[0] + 1 if kday == 0 else 0, 390):
            for kk in (range(1, 7) if tk else (6,)):
                when = m if kk == 6 else round(m + kk / 6, 3)
                S = tk[6 * m + kk - 1] if tk else sc[m]
                real = kk == 6 and m in ob
                O = ob[m][4] if real else None
                if tk:
                    if m not in iv_at:
                        a = sim.last_bar(obars, m - 1, AGE)
                        x = iv_delta(a[4], sc[a[0]], strike, years_to_expiry(d, a[0], exp), RATE, call) if a and sc[a[0]] else None
                        iv_at[m] = x[0] if x else None
                    if iv_at[m] is not None and S is not None:
                        est = max(bs(S, strike, years_to_expiry(d, m, exp), iv_at[m], RATE, call)[0], 0.01)
                        if real: errs.append(est / O - 1)
                        else: O = est
                if fb is not None and not carried and m > fb:  # the failed-break sale takes all that is left, as sim.py
                    if not tk:  # sim.py: at this bar's middle, at once
                        if real: sell(1, "F_break", sim.mid(ob[m]), d, m); return cost, steps, errs
                        continue
                    if O is None: continue
                    if pending and pending[1] == "F_break": sell(1, "F_break", O, d, when); return cost, steps, errs
                    pending = (1, "F_break")
                    continue
                if pending and O is not None:
                    share, rule = pending
                    price = O
                    if not tk: price = sim.mid(ob[m])
                    sell(share, rule, price, d, when)
                    pending = None
                    if rem <= 1e-9: return cost, steps, errs
                if O is None: continue
                if carried and m < MORNING: continue
                g = O / cost - 1
                if carried and nights == 1 and not morning_done:
                    morning_done = True
                    gap = bet * (sd.open / sd.prev_close - 1) * 100 if sd.ok and sd.open and sd.prev_close else None
                    pending = (0.5, "morning_gap_keep") if gap is not None and gap >= GAP_KEEP else (1, "morning_gap_against")
                    continue
                if d == exp and m >= EXPIRY_LAST: pending = (1, "expiry_day"); continue
                if m >= EOD:
                    if decided: continue
                    decided = True
                    if g >= CARRY_MIN and kday + 1 < len(dates) and nights < MAX_NIGHTS:
                        nights += 1; steps.append((d, when, "carry", round(rem, 4), round(O, 4), "eod_carry"))
                    else: pending = (1, "eod_close")
                    continue
                if not sd.ok: continue
                if carried:
                    if g <= OUT: pending = (1, "U_out")
                    continue
                against = S is not None and entry_stock and bet * (S - entry_stock) < 0
                due = next((i for i, (mins, _) in enumerate(CHECKS) if i not in checks_done and m - m0 >= mins), None)
                if due is not None:
                    checks_done.add(due)
                    if against: pending = (CHECKS[due][1], f"U_check{CHECKS[due][0]}"); continue
                if g <= OUT and against: pending = (1, "U_out"); continue
        last = obars[-1]
        if pending and pending[0] >= 1:
            sell(1, pending[1] + "_late", last[4], d, last[0]); return cost, steps, errs
        if not (steps and steps[-1][2] == "carry") and rem > 1e-9:
            sell(1, "day_end_forced", last[4], d, last[0]); return cost, steps, errs
    sdx = day(und, exp)
    val = max(0.0, bet * ((sdx[-1][4] if sdx else 0) - strike))
    steps.append((exp, 389, "sell", round(rem, 4), round(val, 4), "expired"))
    return cost, steps, errs


def rules_of(steps): return "|".join(s[5] for s in steps[1:])


def one(t):
    key = (t["date"], t["sym"], t["minute"])
    sim.X.clear(); sim.X.update(X0)
    c0, s0, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], CAL)
    c1, s1, _ = walk(t, False)
    c2, s2, errs = walk(t, True)
    if c0 is None or c1 is None or c2 is None: return None
    return dict(key=key, ret={"sim": sim.result(c0, s0), "1-min": sim.result(c1, s1), "10-s": sim.result(c2, s2)},
                rules={"sim": rules_of(s0), "1-min": rules_of(s1), "10-s": rules_of(s2)}, errs=errs,
                h={"sim": held(c0, s0), "1-min": held(c1, s1), "10-s": held(c2, s2)},
                first={"sim": s0[1] if len(s0) > 1 else None, "10-s": s2[1] if len(s2) > 1 else None})


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    A, Z, SYMS = ten_window()
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and A <= t["date"] <= Z),
               key=lambda t: (t["date"], int(t["minute"])))
    left_out = [t for t in T if t["sym"] not in SYMS]
    T = [t for t in T if t["sym"] in SYMS]
    if limit: T = T[:limit]
    print(f"10-second database: {A} to {Z}, {len(SYMS)} symbols. Champion-bot trades in the window: {len(T) + len(left_out)}, "
          f"{len(left_out)} left out (symbols not in the database: {', '.join(sorted({t['sym'] for t in left_out}))}).\n")
    with mp.Pool(6) as pool: R = {r["key"]: r for r in pool.map(one, T, chunksize=4) if r}
    key = lambda t: (t["date"], t["sym"], t["minute"])
    T = [t for t in T if key(t) in R]
    bad = [t for t in T if abs(R[key(t)]["ret"]["sim"] - R[key(t)]["ret"]["1-min"]) > 1e-6]
    print(f"Walk check: the 1-minute walk equals sim.walk on {len(T) - len(bad)} of {len(T)} trades"
          + ("" if not bad else "; DIFFERENT: " + ", ".join(f"{t['sym']} {t['date']} {R[key(t)]['ret']['sim']:+.3f} vs {R[key(t)]['ret']['1-min']:+.3f}" for t in bad[:8])))
    errs = sorted(abs(e) for t in T for e in R[key(t)]["errs"])
    if errs:
        q = lambda p: errs[min(len(errs) - 1, int(p * len(errs)))]
        print(f"Option model vs the real minute close ({len(errs):,} minutes): median error {100 * q(0.5):.1f}%, 75th {100 * q(0.75):.1f}%, 90th {100 * q(0.9):.1f}%\n")
    lists = (("fair list (his 40, traded the year before)", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]),
             ("151 unseen", lambda t: t["sym"] not in HIS40), ("all", lambda t: True))
    pt = lambda x: 1e4 * max(-1, x)
    for lname, lf in lists:
        L = [t for t in T if lf(t)]
        if not L: continue
        print(f"### {lname}: {len(L)} trades, {A} to {Z}\n")
        print("| Version | Winners | Per trade at $10K | Without the best 5 (per trade, at 1%) | At 1% (return), worst drop | At 2%, worst drop |\n|---|---|---|---|---|---|")
        for v in VERSIONS:
            if v == "1-min" and not bad: continue
            rows = [dict(date=t["date"], sym=t["sym"], pnl=str(pt(R[key(t)]["ret"][v])), **R[key(t)]["h"][v]) for t in L]
            pnl = [float(r["pnl"]) for r in rows]
            best = set(sorted(range(len(rows)), key=lambda i: -pnl[i])[:5])
            wo = [r for i, r in enumerate(rows) if i not in best]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02); w1, _ = account(wo)
            print(f"| {v} | {100 * sum(x > 0 for x in pnl) / len(pnl):.0f}% | {st.fmean(pnl):+,.0f} | {sum(float(r['pnl']) for r in wo) / len(L):+,.0f}, ${w1:,.0f} "
                  f"| ${a1:,.0f} ({100 * (a1 / 1e5 - 1):+.0f}%), {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |", flush=True)
        d = [(pt(R[key(t)]["ret"]["10-s"]) - pt(R[key(t)]["ret"]["sim"]), t) for t in L]
        ch = [x for x in d if abs(x[0]) > 1]
        print(f"\n10-s vs sim: {len(ch)} of {len(L)} trades end differently, sum {sum(x[0] for x in d):+,.0f} at $10K "
              f"({sum(1 for x in d if x[0] > 1)} better, {sum(1 for x in d if x[0] < -1)} worse).")
        for label, part in (("Biggest gains", sorted(d, key=lambda x: -x[0])[:5]), ("Biggest losses", sorted(d, key=lambda x: x[0])[:5])):
            print(f"{label}: " + "; ".join(f"{t['sym']} {t['date']} {x:+,.0f} (sim {R[key(t)]['rules']['sim']} -> {R[key(t)]['rules']['10-s']})" for x, t in part if abs(x) > 1))
        reasons = {v: collections.Counter(r for t in L for r in R[key(t)]["rules"][v].split("|") if r) for v in ("sim", "10-s")}
        allr = sorted(set(reasons["sim"]) | set(reasons["10-s"]), key=lambda r: -reasons["sim"][r] - reasons["10-s"][r])
        print("Sales by rule (sim / 10-s): " + ", ".join(f"{r} {reasons['sim'][r]} / {reasons['10-s'][r]}" for r in allr) + "\n")
        for v in VERSIONS:
            if v == "1-min": continue
            rows = [dict(date=t["date"], sym=t["sym"], pnl=str(pt(R[key(t)]["ret"][v]))) for t in L]
            top = sorted(zip(rows, L), key=lambda x: -float(x[0]["pnl"]))[:5]
            print(f"Best 5 ({v}): " + ", ".join(f"{t['sym']} {t['date']} {float(r['pnl']):+,.0f}" for r, t in top))
        print()


if __name__ == "__main__":
    main()
