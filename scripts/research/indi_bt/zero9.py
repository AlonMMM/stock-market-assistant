"""The alert strangle, final rule, exported for its page (2026-10-25): delta 0.35 call + put of the same-day expiry on
the first volume alert (09:40-13:00, fair list, news filter, 200+ contracts a leg); when the stock has moved 0.25 S30 from
the fill, sell the wrong leg and put the proceeds into the right leg; trail the kept leg 30% off its high to 15:30; no
confirmation within 60 minutes -> both out. Fills at the bar middle +/- 2% a leg, commission per contract.

  node --env-file=.env <path>/run.mjs zero9.py export <out dir>   -> trades.csv, steps.csv, paths.csv, spy.csv
"""
import csv, datetime as dt, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar
from signals import series
from levels import ctx
import zero5

DELTA, K, WAIT, TRAIL, SH = 0.35, 0.25, 60, 0.30, 0.02
CAL = calendar()
hhmm = lambda m: f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}"


def one(sig):
    date, sym, m, side = sig
    sb = {b[0]: b for b in day(sym, date)}
    if m not in sb: return None
    px = sb[m][4]; x = ctx(sym, date)
    if not x or not x.get("sd"): return None
    sim.C.update(dte_min=0, dte_max=0, delta=DELTA)
    legs, strikes = {}, {}
    for right in ("C", "P"):
        best, why = sim.pick(sym, date, m, right, px)
        if best is None: return dict(skip=f"{right}:{why}", date=date, sym=sym)
        legs[right] = best[0]; strikes[right] = best[2]
    bars = {r: {b[0]: b for b in day(legs[r], date)} for r in legs}
    last, fill_t, path = {}, None, []
    for t in range(m + 1, 361):
        for r in legs:
            if t in bars[r]: last[r] = bars[r][t]
        if len(last) < 2: continue
        if fill_t is None:
            if t > m + 3: break
            fill_t = t; fill_mid = {r: sim.mid(last[r]) for r in legs}; continue
        path.append((t, {r: last[r][4] for r in legs}, {r: sim.mid(last[r]) for r in legs}, sb[t][4] if t in sb else None))
    if fill_t is None or not path: return dict(skip="no_fill", date=date, sym=sym)
    stock0 = sb[fill_t][4] if fill_t in sb else px
    paid = {r: fill_mid[r] * (1 + SH) for r in legs}; cost = sum(paid.values())
    sell1 = lambda mid_: max(mid_ * (1 - SH), 0.01)
    steps = [dict(step=1, minute=fill_t, time=hhmm(fill_t), action="buy", leg="call", contracts=1.0, price=round(paid["C"], 3), amount=round(-paid["C"] * 100, 2)),
             dict(step=1, minute=fill_t, time=hhmm(fill_t), action="buy", leg="put", contracts=1.0, price=round(paid["P"], 3), amount=round(-paid["P"] * 100, 2))]
    conf = None
    for t, closes, mids, spot in path:
        if t - m > WAIT: break
        if spot is None: continue
        mv = spot / stock0 - 1
        if abs(mv) >= K * x["sd"]: conf = (t, "C" if mv > 0 else "P"); break
    got = 0.0
    if conf is None:
        row = next((p for p in path if p[0] - m >= WAIT), path[-1]); t = row[0]
        for r in legs:
            s = sell1(row[2][r]); got += s
            steps.append(dict(step=2, minute=t, time=hhmm(t), action="sell", leg="call" if r == "C" else "put", contracts=1.0, price=round(s, 3), amount=round(s * 100, 2)))
        exit_t, kept, nfills = t, "", 4
    else:
        ct, kept = conf; wrong = "P" if kept == "C" else "C"
        crow = next(p for p in path if p[0] == ct)
        sw = sell1(crow[2][wrong]); add_px = crow[2][kept] * (1 + SH); units = 1.0 + sw / add_px
        steps.append(dict(step=2, minute=ct, time=hhmm(ct), action="sell", leg="call" if wrong == "C" else "put", contracts=1.0, price=round(sw, 3), amount=round(sw * 100, 2)))
        steps.append(dict(step=2, minute=ct, time=hhmm(ct), action="buy", leg="call" if kept == "C" else "put", contracts=round(sw / add_px, 3), price=round(add_px, 3), amount=round(-sw * 100, 2)))
        peak = crow[1][kept]; exit_t = None
        for t, closes, mids, spot in path:
            if t <= ct: continue
            c = closes[kept]; peak = max(peak, c)
            if t >= 360 or c <= peak * (1 - TRAIL): exit_t = t; sk = sell1(mids[kept]); break
        if exit_t is None: t, closes, mids, spot = path[-1]; exit_t = t; sk = sell1(mids[kept])
        got = units * sk
        steps.append(dict(step=3, minute=exit_t, time=hhmm(exit_t), action="sell", leg="call" if kept == "C" else "put", contracts=round(units, 3), price=round(sk, 3), amount=round(units * sk * 100, 2)))
        nfills = 6
    comm = sim.COMM * nfills / (cost * 100)
    ret = got / cost - 1 - comm
    i = CAL.index(date); prev = CAL[i - 1]
    def closes_of(s_, d_):
        c = series(day(s_, d_))[0]; return c
    rows = []
    for which, d_ in (("prev", prev), ("trade", date)):
        sc, yc = closes_of(sym, d_), closes_of("SPY", d_)
        cb = {b[0]: b for b in day(legs["C"], d_)}; pb = {b[0]: b for b in day(legs["P"], d_)}
        lc = lp = None
        for mm in range(390):
            if mm in cb: lc = cb[mm][4]
            if mm in pb: lp = pb[mm][4]
            if which == "prev" and mm % 5 != 4: continue
            rows.append(dict(day=which, minute=mm, time=hhmm(mm), stock=sc[mm], spy=yc[mm], call=lc if which == "trade" else None, put=lp if which == "trade" else None))
    trade = dict(date=date, sym=sym, minute=m, time=hhmm(m), alert=side, fill_minute=fill_t, fill_time=hhmm(fill_t), call=legs["C"], put=legs["P"], call_strike=strikes["C"], put_strike=strikes["P"],
                 paid_call=round(paid["C"], 3), paid_put=round(paid["P"], 3), paid=round(cost * 100, 2), stock_at_fill=round(stock0, 2),
                 confirmed=int(conf is not None), confirm_minute=conf[0] if conf else "", confirm_time=hhmm(conf[0]) if conf else "", kept="call" if kept == "C" else "put" if kept == "P" else "",
                 exit_minute=exit_t, exit_time=hhmm(exit_t), got=round(got * 100, 2), ret=round(ret, 4), pnl10k=round(1e4 * max(-1, ret)), weekday=dt.date.fromisoformat(date).strftime("%a"),
                 prev_date=prev, sd30=round(x["sd"] * 100, 3))
    return dict(trade=trade, steps=steps, path=rows)


def export(out):
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    os.makedirs(out, exist_ok=True)
    ent = zero5.entries()
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], right="C", r=r) for e, r in zip(ent, res) if r]
    nf.features(rows)
    fair = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and "trade" in t["r"]]
    fair.sort(key=lambda t: (t["date"], t["minute"]))
    T, S, Pth = [], [], []
    for n, t in enumerate(fair):
        key = f"{t['date']}|{t['sym']}"
        tr = dict(key=key, n=n + 1, **t["r"]["trade"]); T.append(tr)
        for s in t["r"]["steps"]: S.append(dict(key=key, **s))
        for p in t["r"]["path"]: Pth.append(dict(key=key, **p))
    for name, data in (("trades", T), ("steps", S), ("paths", Pth)):
        with open(f"{out}/{name}.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0])); w.writeheader(); w.writerows(data)
        print(name, len(data), "rows", flush=True)
    spy = [dict(date=d, close=round(day("SPY", d)[-1][4], 2)) for d in CAL if "2024-02-01" <= d <= "2026-10-12" and day("SPY", d)]
    with open(f"{out}/spy.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "close"]); w.writeheader(); w.writerows(spy)
    skipped = [t for t in rows if "skip" in t["r"]]
    print("skipped", len(skipped), "| trades", len(T), "| sum pnl at $10K", sum(x["pnl10k"] for x in T), "| winners", sum(x["pnl10k"] > 0 for x in T))


if __name__ == "__main__":
    export(sys.argv[2])
