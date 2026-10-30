"""Lower thresholds after a volume shock (the user, 2026-10-30: "check if a huge volume can make us enter faster ... we
have the shock rule which would catch the huge oracle move 2 days ago.. our bot also catch it but it could be caught much
faster. see the shock alert and if we get one - you can reduce the T V D thresholds by 30%-50%. after you enter you need
to confirm that during the next X minutes we do go through that threshold. lets run a quick example on oracle before we
test this").

The shock: the Volume bot's F60 rule at 15x (f60_alerts.py F60_K=15, 10-second bars, 09:40-15:30), its side the 60-second
move's. From the alert on, on that side only, the Main bot's rule (volume >= 1.5x and t >= 1.8, or t >= 1.2 and D2 >= 1.5)
with every threshold cut by L (0.3 / 0.5). The confirmation: the full rule holds within X minutes (10 / 20 / 30) of the
entry, else sell.

  node --env-file=.env <dir>/run.mjs shock_lower.py example ORCL 2026-10-28      (from the app repo root)
  -> data/local/x/bt/shock_example_<SYM>_<date>.json
"""
import json, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("F60_K", "15"); os.environ.setdefault("F60_FIRST", "59"); os.environ.setdefault("F60_LAST", "2159")
import f60_alerts
import sim
import store
from store import day, calendar
from signals import series, beta
from levels import ctx
from d2_failed_break import CHAMP

B = "data/local/x/bt"
T_MIN, BONUS_T, D2_MIN, RV_MIN, FIRST, LAST, WINDOW = 1.8, 1.2, 1.5, 1.5, 10, 374, 30
LOWER = (0.0, 0.3, 0.5)
CONFIRM = (10, 20, 30)


def minutes(sym, date):
    """Per session minute: price, SPY, volume, the day volume ratio, and t / D2 for a call (a put is t negated, its own D2)."""
    cal = calendar(); i = cal.index(date)
    bars = day(sym, date); b_ = beta(sym, date, i, cal); unit = ctx(sym, date)["sd"]
    hist = []
    for d in cal[i - 20:i]:
        acc, cum = 0, [0] * 390
        for x in day(sym, d): cum[x[0]] = x[5]
        for m in range(390): acc += cum[m]; cum[m] = acc
        if cum[-1] > 0: hist.append(cum)
    c = series(bars)[0]; spy = series(day("SPY", date))[0]
    vol = [0] * 390
    for x in bars: vol[x[0]] = x[5]
    out, acc, n, s1, s2, win = [], 0, 0, 0.0, 0.0, []
    for m in range(390):
        acc += vol[m]
        ec = ep = 0.0
        if m and c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            rp = spy[m] / spy[m - 1] - 1; x = c[m] / c[m - 1] - 1 - b_ * rp
            n += 1; s1 += x; s2 += x * x
            if rp < 0: ec = x / unit
            if rp > 0: ep = -x / unit
        win.append((ec, ep)); win = win[-WINDOW:]
        mu = s1 / n if n else 0.0; var = max(s2 / n - mu * mu, 0.0) if n else 0.0
        t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
        med = sorted(h[m] for h in hist); k = len(med) // 2
        usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
        out.append(dict(m=m, px=c[m], spy=spy[m], v=vol[m], rv=round(acc / usual, 3) if usual else 0.0, t=round(t, 3),
                        d2c=round(sum(w[0] for w in win), 3), d2p=round(sum(w[1] for w in win), 3), ok=m >= FIRST and n >= 10))
    return out, b_, unit


def holds(r, side, cut):
    """The Main bot's entry rule on one side with every threshold cut by `cut` (0 = the live rule)."""
    k = 1 - cut
    t = r["t"] if side == "C" else -r["t"]
    d2 = r["d2c"] if side == "C" else r["d2p"]
    if not r["ok"] or r["m"] > LAST or r["rv"] < RV_MIN * k: return False
    return t >= T_MIN * k or (t >= BONUS_T * k and d2 >= D2_MIN * k)


def option_path(und, date, minute, right, spot):
    """The contract the picker takes at `minute` (0.15 delta, from $0.20, 200+ contracts in 30 minutes), and its closes."""
    import cheap_up as cu
    exp = sim.expiry_for(und, date)
    ks = [k for k in sim.chain(und, exp, right) if (spot <= k <= spot * 1.25 if right == "C" else spot * 0.75 <= k <= spot)]
    store.fetch_bars("options", [sim.occ(und, exp, k, right) for k in ks], date, date, key=f"shock_ex|{und}|{date}|{right}|{exp}|full")
    cands = cu.candidates(und, date, minute, right, spot)
    p = cu.choose(cands, "none")
    if not p or p[0] is None:
        # skipped like live; the nearest liquid strike (200+ in 30 minutes, from $0.20) shown beside it, not traded
        ok = [c for c in cands if c[5] >= 200 and c[4] >= 0.2]
        alt = min(ok, key=lambda c: abs(c[3] - 0.15)) if ok else None
        return dict(skip=p and p[1], alt=alt and pick_row(alt, date, und, minute, right))
    return pick_row(p[0], date, und, minute, right)


def pick_row(s, date, und, minute, right):
    """A picked contract: its closes on the day and the bot's exits walked on it (the champion's, the minute model)."""
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(und, date, minute, right, s[0], s[1], calendar())
    ret = sim.result(cost, steps, 0.02) if cost else None
    return dict(contract=s[0], strike=s[2], delta=round(s[3], 3), vol30=s[5], closes={b[0]: b[4] for b in day(s[0], date)},
                cost=cost, ret=ret, steps=[list(x) for x in steps])


def example(sym, date):
    end = os.environ.get("EX_END", date)   # the days after, for a trade held overnight
    store.fetch_bars("stocks", [sym, "SPY"], date, end, key=f"shock_ex|{sym}|{date}|{end}|full")   # the whole session
    store._cache.clear()
    rows, b_, unit = minutes(sym, date)
    shocks = [a for a in f60_alerts.one((sym, date, date)) if a["date"] == date]
    for a in shocks:
        m = a["sec"] // 60
        a["minute"] = m
        a["side"] = "C" if rows[m]["px"] and rows[max(0, m - 1)]["px"] and a["price"] >= rows[max(0, m - 2)]["px"] else "P"
    live = next((m for m in range(390) for side in "CP" if holds(rows[m], side, 0)), None)
    entries = []
    for cut in LOWER:
        for a in shocks if cut else [None]:
            start, side = (a["minute"], a["side"]) if a else (0, None)
            m = next((m for m in range(start, 390) for s in ([side] if side else "CP") if holds(rows[m], s, cut)), None)
            if m is None: continue
            s = side or next(s for s in "CP" if holds(rows[m], s, 0))
            full = next((x for x in range(m, 390) if holds(rows[x], s, 0)), None)
            opt = option_path(sym, date, m, s, rows[m]["px"])
            entries.append(dict(cut=cut, shock=a and a["sec"], minute=m, side=s, px=rows[m]["px"], full=full, option=opt,
                                confirmed={x: full is not None and full - m <= x for x in CONFIRM}))
    out = dict(sym=sym, date=date, beta=b_, unit=unit, shocks=shocks, live_rule_minute=live, rows=rows, entries=entries)
    json.dump(out, open(f"{B}/shock_example_{sym}_{date}.json", "w"))
    clock = lambda m: f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}"
    sec = lambda x: f"{(34200 + x) // 3600:02d}:{(34200 + x) % 3600 // 60:02d}:{x % 60:02d}"
    print("shocks:", [(sec(a["sec"]), a["side"], a["price"]) for a in shocks])
    for e in entries:
        o = e["option"] or {}
        if "skip" in o: print(f"cut {e['cut']:.0%}: entry {clock(e['minute'])} skipped ({o['skip']}); nearest liquid {o['alt'] and (o['alt']['contract'], o['alt']['cost'], o['alt']['ret'])}"); continue
        print(f"cut {e['cut']:.0%}: entry {clock(e['minute'])} {e['side']} stock {e['px']} · full rule {clock(e['full']) if e['full'] is not None else '-'}"
              f" · {o.get('contract')} d {o.get('delta')} cost {o.get('cost')} -> {o.get('ret') and round(o['ret'], 3)} · {[(x[0][5:], clock(x[1]), x[2], x[3], x[4], x[5]) for x in o.get('steps', [])]}")


if __name__ == "__main__":
    if sys.argv[1] == "example": example(sys.argv[2], sys.argv[3])
