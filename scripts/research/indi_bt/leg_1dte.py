"""The Alert leg with next-day expiries and overnight holds (the user, 2026-10-25: "what if we add 1DTE as well here -
and let it also have overnight"). The one-leg rule as the live bot runs it (leg_fallback.py's plain pick at the side).
Alert days: the stock's first volume alert 09:40-13:00, news filter; a day counts as 0DTE when the stock has an expiry
that day, as 1DTE when its nearest expiry is the next trading day. The leg at the side, delta 0.35:
  0dte        0DTE days, the same-day leg, out by 15:30 (the bot today)
  1d_day      1DTE days, the next-day leg, out by 15:30 the same day
  1d_night    1DTE days, the next-day leg; not given back by the close, it is held overnight, the give-back continues
              from the same best on the next day (a gap past it sells at the first bar), out by 15:30 on its expiry day
  1d_up       as 1d_night, but held overnight only when the leg is up at 15:30 (else sold at 15:30)
  1d_on0      on 0DTE days, the next-day leg instead of the same-day one (night rule as 1d_night)
Fills at the bar middle +/- 2% (+/- 4% as a check), $0.62 a contract each way, whole contracts from 1% (2%) of each
morning's account from $100,000.

  BT_UNIVERSE=wide node --env-file=.env <path>/run.mjs leg_1dte.py
  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node ... leg_1dte.py
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar, fetch_bars
from levels import ctx
from rvol_alert import alerts_for
from zero5 import SPAN, FIRST, LAST
from leg_fallback import account

DELTA, K, WAIT, GIVE, END, CLOSE, SH = 0.35, 0.25, 60, 0.75, 360, 389, 0.02
CAL = calendar()
C = sim.C
RUN50 = ("b1", "b1f", "b1h", "b1fh", "b1hc", "b1fhc")


def kind_of(sym, date):
    i = CAL.index(date)
    C.update(dte_min=0, dte_max=0)
    if sim.expiry_for(sym, date) == date: return "0"
    if i + 1 < len(CAL):
        C.update(dte_min=1, dte_max=5)
        if sim.expiry_for(sym, date) == CAL[i + 1]: return "1"
    return None


def entries():
    ent = []
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            k = kind_of(sym, date)
            if not k: continue
            al = alerts_for(sym, date, CAL)
            if not al: continue
            m = next((q for q in range(FIRST, LAST + 1) if al[q]), None)
            if m is not None: ent.append((date, sym, m, k))
    return ent


def walk(sym, date, ct, side, contract, spot_side, u, night, run50=None):
    morning = None   # the user's morning rule: 'buy' / 'close' = win measured from the buy / from the close
    if run50 and run50.endswith('hc'): run50, morning = run50[:-2], 'close'
    elif run50 and run50.endswith('h'): run50, morning = run50[:-1], 'buy'
    """night: None (out by 15:30), 'all' (hold if not given back), 'up' (hold only when up at 15:30).
    run50 (1DTE, the user's "let it run overnight if it's up more than 50%"): once the leg's sale price is +50% over the
    buy, the day's give-back stops; at the close it is held overnight if still +50% (else sold at the close); next day
    the 0.75 give-back from the best since the side, out by 15:30.
      'b1'  as above          'b1f' also sold the same day if it falls back to +20%
      'b2'  next day's give-back from the next day's open, not the old best
      'b3'  after +50% the day's give-back widens to 1.5 S30 instead of stopping
    A suffix 'h' / 'hc' adds the morning rule (the user, 2026-10-25: "sale after the night - 50% if we win, 100% if we
    loose"): at the leg's first bar the next day, up from the buy ('h') or from the close ('hc'): half sold there, the
    rest on the give-back; down: all sold there."""
    d2 = CAL[CAL.index(date) + 1]
    kb = {b[0]: b for b in day(contract, date)}
    sb = {b[0]: b for b in day(sym, date)}
    b0 = next((kb[q] for q in range(ct, ct + 4) if q in kb), None)
    if not b0: return None
    buy = sim.mid(b0) * (1 + SH); last = b0; best = spot_side
    sell = lambda b: max(sim.mid(b) * (1 - SH), 0.01)
    give = GIVE; ran = False
    gave = lambda spot: abs(spot / best - 1) >= give * u
    for t in range(b0[0] + 1, CLOSE + 1):
        if t in kb: last = kb[t]
        spot = sb[t][4] if t in sb else None
        if spot: best = max(best, spot) if side == "C" else min(best, spot)
        if run50 and not ran and sell(last) >= buy * 1.5:
            ran = True
            if run50 == "b3": give = 1.5
        out1 = (buy, sell(last), 0, dict(b=b0[0], d="t", m=t))
        if ran and run50 == "b1f" and sell(last) <= buy * 1.2: return out1
        if spot and gave(spot) and not (ran and run50 in ("b1", "b1f", "b2")): return out1
        if run50:
            if t == END and not ran: return out1
            if t == CLOSE and sell(last) < buy * 1.5: return out1
            continue
        if t == END and (night is None or (night == "up" and sell(last) <= buy)): return out1
    # overnight
    fetch_bars("options", [contract], d2, d2, key=f"n1|{contract}|{d2}")
    kb2 = {b[0]: b for b in day(contract, d2)}; sb2 = {b[0]: b for b in day(sym, d2)}
    if not kb2 or not sb2: return buy, sell(last), 1, dict(b=b0[0], d="t", m=CLOSE)
    give = GIVE; close_px = sell(last); half = None; half_m = None
    if run50 == "b2":
        o = next((sb2[q][4] for q in range(0, 10) if q in sb2), None)
        if o: best = o
    for t in range(0, END + 1):
        if t in kb2: last = kb2[t]
        spot = sb2[t][4] if t in sb2 else None
        if t not in kb2 and t < 5: continue   # wait for the leg's first bar of the day
        if morning and half is None:
            px = sell(last)
            if px < (buy if morning == "buy" else close_px): return buy, px, 1, dict(b=b0[0], d="n", m=t)
            half = px; half_m = t
            continue
        if spot: best = max(best, spot) if side == "C" else min(best, spot)
        if (spot and gave(spot)) or t >= END:
            return buy, (sell(last) if half is None else (half + sell(last)) / 2), 1, dict(b=b0[0], d="n", m=t, half=half, half_m=half_m if half else None)
    return buy, (sell(last) if half is None else (half + sell(last)) / 2), 1, dict(b=b0[0], d="n", m=END, half=half, half_m=half_m if half else None)


def one(sig):
    date, sym, m, kind = sig
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if m not in sb or not x or not x.get("sd"): return None
    u, stock0 = x["sd"], sb[m][4]
    side = None
    for t in range(m + 1, m + WAIT + 1):
        if t in sb and abs(sb[t][4] / stock0 - 1) >= K * u: side = (t, "C" if sb[t][4] > stock0 else "P"); break
    if not side: return dict(kind=kind)
    ct, right = side; spot = sb[ct][4]
    out = dict(kind=kind)
    plans = [("0dte", 0, None)] if kind == "0" else [("1d_day", 1, None), ("1d_night", 1, "all")] + [(f"1d_{r}", 1, r) for r in RUN50]
    if os.environ.get("BT_ON0") and kind == "0": plans.append(("1d_on0", 1, "all"))
    for name, dte, night in plans:
        if dte == 0: C.update(dte_min=0, dte_max=0, delta=DELTA)
        else: C.update(dte_min=1, dte_max=5, delta=DELTA)
        got, why = sim.pick(sym, date, ct, right, spot)
        if got is None: continue
        if dte == 1 and got[1] != CAL[CAL.index(date) + 1]: continue
        w = walk(sym, date, ct, right, got[0], spot, u, night if dte else None) if night not in RUN50 else walk(sym, date, ct, right, got[0], spot, u, 'all', night)
        if w: out[name] = dict(buy=w[0], sell=w[1], night=w[2], delta=round(abs(got[3]), 2))
    return out


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    ent = [e for e in entries() if lo <= e[0] <= hi]
    print(len(ent), "first alerts:", sum(e[3] == "0" for e in ent), "on 0DTE days,", sum(e[3] == "1" for e in ent), "on 1DTE days", flush=True)
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], right="C", r=r) for e, r in zip(ent, res) if r]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)]
    leg = lambda t, k: dict(date=t["date"], minute=t["minute"], sym=t["sym"], **t["r"][k])
    pick = lambda keys: [leg(t, k) for t in keep for k in keys if k in t["r"]]
    combos = [
        ("as now: 0DTE days only", ["0dte"]),
        ("+ 1DTE days, out by 15:30", ["0dte", "1d_day"]),
        ("+ 1DTE, from +50% no give-back, overnight if still +50% (b1)", ["0dte", "1d_b1"]),
        ("+ b1, morning: up from the buy half, down all", ["0dte", "1d_b1h"]),
        ("+ b1, morning: up from the close half, down all", ["0dte", "1d_b1hc"]),
        ("+ 1DTE, b1 sold if back to +20% (b1f)", ["0dte", "1d_b1f"]),
        ("+ b1f, morning: up from the buy half, down all", ["0dte", "1d_b1fh"]),
        ("+ b1f, morning: up from the close half, down all", ["0dte", "1d_b1fhc"]),
    ]
    print("\n| Version | Trades | Held overnight | Winners | 1%, ±2%: end, worst drop | without best 5 | 1%, ±4% | 2%, ±2% | by year (1%, ±2%) |")
    print("|---|---|---|---|---|---|---|---|---|")
    for lab, keys in combos:
        T = pick(keys)
        e1, d1, R = account(T, 1, 2)
        top = {(r["date"], r["sym"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
        e5, _, _ = account([t for t in T if (t["date"], t["sym"]) not in top], 1, 2)
        e4, d4, _ = account(T, 1, 4); e2, d2, _ = account(T, 2, 2)
        yrs = {}
        for r in R: yrs[r["date"][:4]] = yrs.get(r["date"][:4], 0) + r["pnl"]
        print(f"| {lab} | {len(R)} | {sum(r['night'] for r in R)} | {100 * sum(r['pnl'] > 0 for r in R) / max(1, len(R)):.0f}% | ${e1:,.0f}, {100 * d1:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% | ${e2:,.0f}, {100 * d2:.1f}% | "
              + ", ".join(f"{y} {v:+,.0f}" for y, v in sorted(yrs.items())) + " |")
    print("\n| 1DTE trades alone | Trades | Held overnight | Their P&L | Overnight trades' P&L (winners) |\n|---|---|---|---|---|")
    for k in ("1d_day",) + tuple(f"1d_{r}" for r in RUN50):
        R = account(pick([k]), 1, 2)[2]; on = [r for r in R if r["night"]]
        print(f"| {k} | {len(R)} | {len(on)} | {sum(r['pnl'] for r in R):+,.0f} | {sum(r['pnl'] for r in on):+,.0f} ({sum(r['pnl'] > 0 for r in on)}) |")

if __name__ == "__main__":
    main()
