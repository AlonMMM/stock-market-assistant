"""The alerts and trades of late_reset.py's pick r30-a, tune weeks only, for a chart page (the user, 2026-11-06: "I would
like to see a list of all the alerts + trades, with open to graph like we have on the backtest app, only for the tune
list"). r30-a: from 15:30 to 15:44, the champion's strength (t >= 1.8, or t >= 1.2 and D2 >= 1.5) with the last 30
minutes' volume >= 1.25x usual; one late trade a stock a day, held overnight whatever its result (2.10's stops to 15:50).
Every stock-day with such an alert in the tune weeks (fair list + Favorites 24 months), what happened to each alert
minute (traded, 2.10 still open, 2.10's own signal in the window, the pick too cheap / thin, Friday, earnings day /
pre-market 4x+), and per stock-day the chart data: the stock and SPY by minute (the day, and the next day when held),
volume, the t vs SPY x beta, and for a trade the option's mid by minute, what was paid and the fills.

  node --env-file=.env <dir>/run.mjs late_chart.py <out dir>      (from the app repo root; after late_reset.py)
-> <out dir>/alerts.json, <out dir>/days/<YYYY-MM>.json
"""
import collections, datetime as dt, json, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import late_reset as LR
import thin_strike as TS
import sim
import cheap_up as cu
import fav_real as FR
import news_filter as nf
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from low_delta import HIS40, PRIOR
from signals import series, beta
from store import day
from split import half
from zoneinfo import ZoneInfo
import csv, glob

M1, LAST = 360, 374
CAL = TS.CAL
NY, IL = ZoneInfo("America/New_York"), ZoneInfo("Asia/Jerusalem")


def il_offset(date):
    """Minutes Israel is ahead of New York on that day."""
    a = dt.datetime.fromisoformat(f"{date}T12:00").replace(tzinfo=NY)
    return int((a.astimezone(IL).utcoffset() - a.utcoffset()).total_seconds() // 60)


def tseries(sym, date):
    """The bot's t (minute excess vs beta x SPY since the open) for minutes 0..389, None before 10 steps."""
    i = CAL.index(date)
    b_ = beta(sym, date, i, CAL)
    c, s = series(day(sym, date))[0], series(day("SPY", date))[0]
    out, n, s1, s2 = [None] * 390, 0, 0.0, 0.0
    if b_ is None: return out
    for m in range(1, 390):
        if c[m] and c[m - 1] and s[m] and s[m - 1]:
            x = c[m] / c[m - 1] - 1 - b_ * (s[m] / s[m - 1] - 1)
            n += 1; s1 += x; s2 += x * x
        if n >= 10:
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            out[m] = round(mu / math.sqrt(var) * math.sqrt(n), 2) if var > 0 else 0.0
    return out


def walk_steps(t, m, c):
    over = {"carry_min_gain": -1.0, "carry_range_pos": 0.0}
    sim.X.clear(); sim.X.update(CHAMP); sim.X.update(over)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    sim.X.clear(); sim.X.update(CHAMP); sim.X.update(over)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL, paid=rcost)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    return rcost, real, sim.result(rcost, real, 0.01)


def leg(sym, date, m, right, price, b):
    """A bought leg on pick b at minute m: the walk, the fills, the nights held and the book as the minute closed."""
    w = walk_steps(dict(sym=sym, date=date, right=right, minute=str(m), price=price), m, b)
    if w is None: return None
    rcost, real, r1 = w
    q = RB.quote(b[0], date, m + 1)
    days = sorted({d for d, *_ in real})
    return dict(minute=m, right=right, contract=b[0], strike=b[2], expiry=b[1], delta=round(abs(b[3]), 3), price=b[4],
                vol30=b[5], paid=round(rcost, 4), r1=round(r1, 4), usd=round(1e4 * max(-1, r1)), nights=len(days) - 1,
                book=bool(RB.quote(b[0], date, m)), bid=None if not q else q[0], ask=None if not q else q[1],
                fills=[dict(date=d, minute=mm, side=sd, q=q_, px=px, rule=rule) for d, mm, sd, q_, px, rule in real])


def rows():
    """Every r30 alert minute 15:30-15:44 in the tune weeks on the two lists, with why it is not a candidate."""
    R = [r for f in sorted(glob.glob(f"{LR.B}/s_late_20*.csv")) for r in csv.DictReader(open(f))]
    R = [r for r in R if M1 <= int(r["minute"]) <= LAST and float(r["c_rv30"]) >= 1.25 and half(r["date"]) == "tune" and r["date"] <= RB.LAST]
    for r in R: r["minute"] = int(r["minute"])
    nf.features(R)
    out = collections.defaultdict(list)
    for r in R:
        lists = []
        if r["sym"] in HIS40 and r["sym"] in PRIOR[r["date"][:4]]: lists.append("fair")
        if r["sym"] in FR.FAV and FR.A24 <= r["date"] <= FR.Z: lists.append("fav")
        if not lists: continue
        r["lists"] = lists
        r["block"] = None
        if r["e_next"] == 0: r["block"] = "Earnings reaction day"
        elif r["pre_rvol"] is not None and r["pre_rvol"] >= 4: r["block"] = "Pre-market volume 4x+"
        elif dt.date.fromisoformat(r["date"]).weekday() == 4: r["block"] = "Friday (no night)"
        out[(r["sym"], r["date"])].append(r)
    return out


def champ_legs():
    """2.10's main signals by stock-day: (minute, the walk's open share by minute or {} when it did not trade)."""
    mains = [("fair", t) for t in LR.fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25")]
    mains = [(s, t) for s, t in mains if half(t["date"]) == "tune"]
    with mp.Pool(8) as pool: C = pool.map(champ_one, mains, chunksize=4)
    out = collections.defaultdict(list)
    for (src, t), x in zip(mains, C):
        out[(t["sym"], t["date"])].append(dict(minute=int(t["minute"]), open=x or {}, traded=x is not None, right=t["right"]))
    return out


def champ_one(job):
    src, t = job
    LR.dbx(src)
    m0 = int(t["minute"])
    b = LR.champ_pick(t["sym"], t["date"], m0, t["right"], float(t["price"]))
    if not b: return None
    x = TS.walk_c(t, m0, b)
    if x is None: return None
    return {m: s for m, (s, _) in x["held"].items()}


def one(job):
    (sym, date), alerts, champ = job
    src = "fair" if "fair" in alerts[0]["lists"] else "fav"
    LR.dbx(src)
    own = [c for c in champ if c["minute"] >= LR.WINS["15"]]
    ev, trade = [], None
    for r in sorted(alerts, key=lambda r: (r["minute"], r["right"])):
        m = r["minute"]
        e = dict(minute=m, right=r["right"], t=float(r["c_t"]), d2=float(r["c_e"]), rv30=float(r["c_rv30"]), rvol=float(r["c_rvol"]))
        if trade: e["status"] = "Already traded"
        elif r["block"]: e["status"] = r["block"]
        elif any(c["minute"] >= M1 for c in champ): e["status"] = "2.10's own signal in the window"
        elif any(c["minute"] < m and c["open"].get(m, 0) > 0 for c in champ): e["status"] = "2.10 position still open"
        else:
            cands = cu.candidates(sym, date, m, r["right"], float(r["price"]))
            b = min(cands, key=lambda c: abs(c[3] - 0.15)) if cands else None
            if not b: e["status"] = "No contract"
            elif b[4] < LR.floor_of(sym): e["status"] = f"Too cheap (${b[4]:.2f})"
            elif b[5] < 200: e["status"] = f"Thin ({b[5]} in 30 min)"
            else:
                w = leg(sym, date, m, r["right"], r["price"], b)
                if w is None: e["status"] = "No price path"
                else: e["status"] = "Traded"; trade = w
        ev.append(e)
    model = False
    if not trade:   # the what-if: the first alert's 0.15 pick bought anyway, the same exits (the app's "model" row)
        e0 = ev[0]; r0 = next(r for r in alerts if r["minute"] == e0["minute"] and r["right"] == e0["right"])
        cands = cu.candidates(sym, date, e0["minute"], e0["right"], float(r0["price"]))
        b = min(cands, key=lambda c: abs(c[3] - 0.15)) if cands else None
        if b and b[4] > 0: trade = leg(sym, date, e0["minute"], e0["right"], r0["price"], b); model = trade is not None
    if trade: trade["model"] = model
    days = [date]
    if trade and any(f["date"] != date for f in trade["fills"]):
        days += sorted({f["date"] for f in trade["fills"] if f["date"] != date})
    chart = dict(days=[], il=il_offset(date))
    for d in days:
        c, _, _, v = series(day(sym, d)); s = series(day("SPY", d))[0]
        k = CAL.index(d)
        pc = (day(sym, CAL[k - 1]) or [[0, 0, 0, 0, None]])[-1][4]
        ps = (day("SPY", CAL[k - 1]) or [[0, 0, 0, 0, None]])[-1][4]
        x = dict(date=d, c=c, spy=s, v=v, prev=pc, spy_prev=ps)
        if d == date: x["t"] = tseries(sym, d)
        if trade:
            opt = []
            ob = {b[0]: b for b in day(trade["contract"], d)}
            for m in range(390):
                q = RB.quote(trade["contract"], d, m)
                if q: opt.append(round((q[0] + q[1]) / 2, 3))
                elif m in ob: opt.append(ob[m][4])
                else: opt.append(None)
            x["opt"] = opt
            x["ov"] = [ob[m][5] if m in ob else 0 for m in range(390)]
        chart["days"].append(x)
    status = "Traded" if trade and not model else ev[0]["status"]
    return dict(sym=sym, date=date, lists=alerts[0]["lists"], first=ev[0]["minute"], n=len(ev), status=status, off=chart["il"],
                own=[dict(minute=c["minute"], right=c["right"], traded=c["traded"]) for c in champ],
                events=ev, trade=trade), chart


def main():
    out = sys.argv[1]
    os.makedirs(f"{out}/days", exist_ok=True)
    A = rows()
    C = champ_legs()
    jobs = [(k, v, C.get(k, [])) for k, v in sorted(A.items(), key=lambda kv: (kv[0][1], kv[0][0]))]
    print(len(jobs), "stock-days with an alert (tune)", flush=True)
    with mp.Pool(8) as pool: X = pool.map(one, jobs, chunksize=2)
    months = collections.defaultdict(dict)
    for info, chart in X: months[info["date"][:7]][f"{info['sym']}|{info['date']}"] = chart
    json.dump([info for info, _ in X], open(f"{out}/alerts.json", "w"), separators=(",", ":"))
    for mo, d in months.items(): json.dump(d, open(f"{out}/days/{mo}.json", "w"), separators=(",", ":"))
    st = collections.Counter(i["status"] for i, _ in X)
    print(dict(st), "trades:", sum(1 for i, _ in X if i["trade"] and not i["trade"]["model"]), flush=True)


if __name__ == "__main__":
    main()
