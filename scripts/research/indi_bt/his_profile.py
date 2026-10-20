"""What his entries look like at the minute he buys, against the bot's entries and random moments, and his
entries clustered into setups.

  python3 his_profile.py        (from the repo root) -> data/local/x/bt/profile_rows.csv + printed tables

Every feature uses bars up to and including the entry minute only. Directional features are signed so that
+ means "his way" (up for a call, down for a put).
"""
import collections, csv, glob, json, math, os, random, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta
import report

B = "data/local/x/bt"
U = P["universe"]
cal = calendar(); IDX = {d: i for i, d in enumerate(cal)}
_vol = {}


def vol_profile(sym, i0):
    """20-day median cumulative volume per minute (normal for that time of day)."""
    k = (sym, i0)
    if k not in _vol:
        hist = []
        for d in cal[max(0, i0 - 20):i0]:
            v = [0] * 390
            for b in day(sym, d): v[b[0]] = b[5]
            c_, t_ = [0] * 390, 0
            for m in range(390): t_ += v[m]; c_[m] = t_
            if c_[-1] > 0: hist.append(c_)
        _vol[k] = [st.median(h[m] for h in hist) for m in range(390)] if len(hist) >= 10 else None
    return _vol[k]


def feat(sym, date, m, bet):
    i0 = IDX.get(date)
    if not i0 or i0 < 6: return None
    bars = day(sym, date)
    if len(bars) < 300: return None
    c, h, l, v = series(bars)
    spy = series(day("SPY", date))[0]
    m = min(m, 389)
    while m > 0 and c[m] is None: m -= 1
    if c[m] is None or not spy[m] or not spy[0]: return None
    pb = day(sym, cal[i0 - 1]); p5 = day(sym, cal[i0 - 6]); pp = day(sym, cal[i0 - 2])
    if not pb or not p5 or not pp: return None
    pc, phi, plo = pb[-1][4], max(x[2] for x in pb), min(x[3] for x in pb)
    o = bars[0][1]
    bt = beta(sym, date, i0, cal) or 1.0
    s = lambda a, b_: bet * (a / b_ - 1) * 100 if a and b_ else None
    def back(n):
        j = max(0, m - n)
        while j < m and c[j] is None: j += 1
        return j
    def mv(n): return s(c[m], c[back(n)])
    def ex(n):
        j = back(n)
        return mv(n) - bt * bet * (spy[m] / spy[j] - 1) * 100 if spy[j] and mv(n) is not None else None
    hh = [x for x in h[:m] if x]; ll = [x for x in l[:m] if x]
    dhi, dlo = (max(hh), min(ll)) if hh else (c[m], c[m])
    w60h = [x for x in h[max(0, m - 60):m] if x]; w60l = [x for x in l[max(0, m - 60):m] if x]
    ref60 = (max(w60h) if bet > 0 else min(w60l)) if w60h else c[m]
    w30 = [(h[j], l[j]) for j in range(max(0, m - 30), m + 1) if h[j]]
    rng30 = (max(a for a, _ in w30) - min(b_ for _, b_ in w30)) / c[m] * 100 if w30 else 0
    rngday = (max(dhi, c[m]) - min(dlo, c[m])) / c[m] * 100
    pv = sum((h[j] + l[j] + c[j]) / 3 * v[j] for j in range(m + 1) if c[j]); vv = sum(v[j] for j in range(m + 1) if c[j])
    vw = pv / vv if vv else c[m]
    prof = vol_profile(sym, i0)
    cum = sum(v[:m + 1])
    rv = cum / prof[m] if prof and prof[m] else None
    def rvn(n):
        if not prof: return None
        a = sum(v[max(0, m - n + 1):m + 1]); b_ = prof[m] - (prof[m - n] if m >= n else 0)
        return a / b_ if b_ else None
    # steadiness: t-stat of 1-minute excess moves since the open
    steps = [bet * ((c[j] / c[j - 1] - 1) - bt * (spy[j] / spy[j - 1] - 1)) for j in range(1, m + 1) if c[j] and c[j - 1] and spy[j] and spy[j - 1]]
    sd = st.pstdev(steps) if len(steps) > 2 else 0
    tst = st.fmean(steps) / sd * math.sqrt(len(steps)) if sd else 0
    last_ext = max((j for j in range(m + 1) if c[j] and (c[j] >= max([x for x in c[:j + 1] if x]) if bet > 0 else c[j] <= min([x for x in c[:j + 1] if x]))), default=0)
    fwd = s(c[389] if c[389] else c[m], c[m])
    fwd = fwd - bt * bet * (spy[389] / spy[m] - 1) * 100 if fwd is not None and spy[389] else fwd
    return dict(
        tod=m, gap=s(o, pc), mv_open=s(c[m], o), ex_open=ex(m), mv5=mv(5), mv15=mv(15), mv60=mv(60), ex15=ex(15),
        spy_open=bet * (spy[m] / spy[0] - 1) * 100, spy15=bet * (spy[m] / spy[back(15)] - 1) * 100,
        range_pos=((c[m] - dlo) / (dhi - dlo) if bet > 0 else (dhi - c[m]) / (dhi - dlo)) if dhi > dlo else 0.5,
        brk60=int(c[m] > ref60 if bet > 0 else c[m] < ref60), dist60=s(c[m], ref60),
        day_ext=int(c[m] > dhi if bet > 0 else c[m] < dlo), prev_out=int(c[m] > phi if bet > 0 else c[m] < plo),
        vwap_side=int(c[m] > vw if bet > 0 else c[m] < vw), vwap_dist=s(c[m], vw),
        rvol_day=rv, rvol15=rvn(15), rvol5=rvn(5), squeeze=rng30 / rngday if rngday else 1, t=tst,
        since_ext=m - last_ext, prev_day=s(pc, pp[-1][4]), ret5d=s(pc, p5[-1][4]), fwd_close=fwd)


def main():
    rows = []
    real = {}
    for y in ("2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] == "silexx" and r["realized_step"]: real[r["trade"]] = real.get(r["trade"], 0) + float(r["realized_step"])
    miss = {(x["date"], x["sym"], x["minute"]): x for x in csv.DictReader(open(f"{B}/t_his_miss.csv"))}
    for y in ("2024", "2025", "2026"):
        for hrow in csv.DictReader(open(f"{B}/t_sig_his_{y}.csv")):
            bet = 1 if hrow["right"] == "C" else -1
            f = feat(hrow["sym"], hrow["date"], int(hrow["minute"]), bet)
            if not f: continue
            mm = miss.get((hrow["date"], hrow["sym"], hrow["minute"]), {})
            rows.append(dict(set="his", date=hrow["date"], sym=hrow["sym"], right=hrow["right"], minute=int(hrow["minute"]),
                             pnl=float(mm["pnl"]) if mm.get("pnl") else None, real=real.get(hrow["his_trade"]), group=mm.get("group", ""), **f))
        for fn in glob.glob(f"{B}/t_flat_{y}.[0-9]_trades.csv"):
            for t in csv.DictReader(open(fn)):
                if t["status"] != "ok": continue
                f = feat(t["sym"], t["date"], int(t["minute"]), 1 if t["right"] == "C" else -1)
                if f: rows.append(dict(set="bot", date=t["date"], sym=t["sym"], right=t["right"], minute=int(t["minute"]), pnl=float(t["pnl"]), **f))
    rng = random.Random(11)
    days = [d for d in cal if "2024-02-01" <= d <= "2026-10-12"]
    while sum(r["set"] == "random" for r in rows) < 3000:
        sym, d, m = rng.choice(U), rng.choice(days), rng.randint(5, 374)
        bars = day(sym, d)
        if len(bars) < 300: continue
        c = series(bars)[0]
        if not c[m] or not bars[0][1]: continue
        bet = 1 if c[m] >= bars[0][1] else -1  # with the day's move so far
        f = feat(sym, d, m, bet)
        if f: rows.append(dict(set="random", date=d, sym=sym, right="C" if bet > 0 else "P", minute=m, **f))
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(f"{B}/profile_rows.csv", "w") as fh:
        w = csv.DictWriter(fh, fieldnames=keys); w.writeheader(); w.writerows(rows)
    print(len(rows), "rows ->", f"{B}/profile_rows.csv")


if __name__ == "__main__":
    main()
