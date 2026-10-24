"""Data files for the Backtest Reports dashboard, from lists.py runs (data/local/x/bt/list_<name>_<A>_<Z>.json).

  trades.csv   one row per bought trade: list, key, date, time, minute, sym, right, contract, strike, expiry, dte, delta, iv,
               price (the stock's close on the signal minute, the entry the checks compare with), cost, ret, exit (words), overnight
  funnel.csv   per list: signals, skipped by the news filter, no contract, no fill, bought
  funnel_stock.csv  the same per list and stock, the no-contract signals split by reason (illiquid, too cheap, other)
  bars.csv     1-minute closes of each trade's stock on the day before and the trade day, and SPY on those days
               (key "SYM|date", 390 slots a day, blank where no bar)
  paths.csv    per trade: the paid price, every fill (day,minute,side,share,price,rule; ...), the option's 1-minute closes
               per day held ("date: c c c|date2: ..."), its volume per minute the same way, and the stock's closes on
               carried days
  minutes.csv  per stock-day of bars.csv (not SPY): the stock's volume per minute on the day before and the trade day,
               and on the trade day the signal's strength per minute as "t;rvol" (the cumulative t-stat vs SPY x beta and
               the volume vs its usual, as tune_signals.py computes them; blank before the 5th step)

  python3 export_lists.py <A> <Z> <name> [<name> ...]     (from the repo root) -> data/local/x/bt/viz_lists/
  A name may carry its own range, <name>@<A>_<Z> (e.g. semis_fb@2025-10-23_2026-10-22), to export studies of
  different periods together.
"""
import csv, datetime as dt, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import math, statistics as stat
from store import day, calendar
from signals import beta, series

B = "data/local/x/bt"
OUT = f"{B}/viz_lists"
os.makedirs(OUT, exist_ok=True)
A, Z, NAMES = sys.argv[1], sys.argv[2], sys.argv[3:]
PER = 390  # one slot per session minute (5-minute slots, 78, until 2026-10-24)

EXIT_WORDS = {
    "U_check10": "Stop: 10-min check", "U_check20": "Stop: 20-min check", "U_out": "Stop: option −30%",
    "eod_close": "Sold 15:50", "morning_gap_keep": "Morning: sold half on the gap", "morning_gap_against": "Morning: gap against",
    "expiry_day": "Expiry day", "day_end_forced": "Day end, contracts left", "expired": "Expired",
    "F_break": "Failed break: sold all",
}


def exit_words(rule):
    base = rule.replace("_late", "")
    return EXIT_WORDS.get(base, rule)


def volumes(bars):
    out = [""] * PER
    for b in bars: out[min(PER - 1, b[0] * PER // 390)] = str(int(b[5]))
    return out


def strength(sym, date, i):
    """Per minute of the trade day: 't;rvol' (the signal's statistic vs SPY x beta from the open, and the day's volume so far
    vs its usual at that minute over the 20 sessions before), '' where not computable. As tune_signals.stock."""
    out = [""] * PER
    b_ = beta(sym, date, i, cal)
    bars = day(sym, date)
    if b_ is None or not bars or i < 21: return out
    hist = []
    for d in cal[i - 20:i]:
        v = [0] * 390
        for x in day(sym, d): v[x[0]] = x[5]
        acc, cum = 0, []
        for x in v: acc += x; cum.append(acc)
        if cum[-1] > 0: hist.append(cum)
    c = series(bars)[0]; spy = series(day("SPY", date))[0]
    vol = [0] * 390
    for x in bars: vol[x[0]] = x[5]
    cum, acc = [], 0
    for x in vol: acc += x; cum.append(acc)
    n = s1 = s2 = 0.0
    for m in range(1, 390):
        if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            x = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
            n += 1; s1 += x; s2 += x * x
        if n < 5 or c[m] is None: continue
        mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
        t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
        rvol = ""
        if len(hist) >= 10:
            usual = stat.median(h[m] for h in hist)
            rvol = f"{cum[m] / usual:.2f}" if usual else ""
        out[min(PER - 1, m * PER // 390)] = f"{t:.2f};{rvol}"
    return out


def closes5(bars):
    """PER slots of closes from 1-minute bars (minute, o, h, l, c, v), one a minute; '' where the minute has no bar."""
    out = [""] * PER
    for b in bars:
        k = min(PER - 1, b[0] * PER // 390)
        out[k] = f"{b[4]:.5g}"
    return out


cal = calendar()
T, F, FS, PA, keys = [], [], [], [], set()
for spec in NAMES:
    name, _, rng = spec.partition("@")
    W = json.load(open(f"{B}/list_{name}_{rng or f'{A}_{Z}'}.json"))
    n = {"signals": len(W), "skipped": 0, "no_contract": 0, "no_fill": 0, "bought": 0}
    for r in W:
        s = r["status"].split(":")[0].replace(" ", "_")
        n[s] = n.get(s, 0) + 1
    F.append(dict(list=name, **n))
    per = {}
    for r in W:
        c = per.setdefault(r["sym"], {"signals": 0, "skipped": 0, "no_contract": 0, "illiquid": 0, "too_cheap": 0, "other": 0, "no_fill": 0, "bought": 0})
        s, _, why = r["status"].partition(":")
        c["signals"] += 1; c[s.replace(" ", "_")] += 1
        if s == "no contract": c[why.strip() if why.strip() in ("illiquid", "too_cheap") else "other"] += 1
    FS.extend(dict(list=name, key=f"{name}|{sym}", sym=sym, **c) for sym, c in sorted(per.items()))
    for r in W:
        if r["status"] != "bought" or r["ret"] is None: continue
        steps = [x.split(" ") for x in r["steps"].split(";")] if r["steps"] else []
        # "date minute side share @price rule" per step; the buy itself is the signal's next bar
        fills = [[r["date"], str(int(r["minute"]) + 1), "buy", "1.0", f"{r['cost']:.4f}", "entry"]]
        for d, m, side, q, px, rule in steps: fills.append([d, m, side, q, px.lstrip("@"), rule])
        sells = [f for f in fills if f[2] == "sell"]
        last = sells[-1] if sells else fills[-1]
        exp = dt.date.fromisoformat(r["expiry"]); d0 = dt.date.fromisoformat(r["date"])
        key = f"{name}-{r['date']}-{r['sym']}-{r['right']}-{r['minute']}"
        T.append(dict(list=name, key=key, date=r["date"], time=r["time"], minute=r["minute"], sym=r["sym"], right=r["right"],
                      contract=r["contract"], strike=r["strike"], expiry=r["expiry"], dte=(exp - d0).days, delta=r["delta"],
                      iv=r.get("iv", ""), price=r["price"], cost=r["cost"], ret=r["ret"], exit=exit_words(last[5]), overnight=int(last[0] != r["date"]),
                      t=r["c_t"], rvol=r["c_rvol"]))
        days = [d for d in cal if r["date"] <= d <= last[0]]
        opt = "|".join(f"{d}: " + " ".join(closes5([b for b in day(r["contract"], d) if d != r["date"] or b[0] >= int(r["minute"])])) for d in days)
        after = "|".join(f"{d}: " + " ".join(closes5(day(r["sym"], d))) for d in days[1:])
        ovol = "|".join(f"{d}: " + " ".join(volumes([b for b in day(r["contract"], d) if d != r["date"] or b[0] >= int(r["minute"])])) for d in days)
        PA.append(dict(key=key, cost=r["cost"], steps=";".join(",".join(f) for f in fills), option=opt, option_vol=ovol, stock_after=after))
        i = cal.index(r["date"])
        for sym in (r["sym"], "SPY"): keys.add((sym, r["date"], cal[i - 1]))

BARS = [dict(key=f"{sym}|{d}", prev_date=pd, closes=" ".join(closes5(day(sym, pd)) + closes5(day(sym, d)))) for sym, d, pd in sorted(keys)]
MIN = [dict(key=f"{sym}|{d}", volumes=" ".join(volumes(day(sym, pd)) + volumes(day(sym, d))), strength=" ".join(strength(sym, d, cal.index(d))))
       for sym, d, pd in sorted(keys) if sym != "SPY"]


def write(fname, rows):
    with open(f"{OUT}/{fname}", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(fname, len(rows), os.path.getsize(f"{OUT}/{fname}") // 1024, "KB")


write("trades.csv", T); write("funnel.csv", F); write("funnel_stock.csv", FS); write("bars.csv", BARS); write("paths.csv", PA); write("minutes.csv", MIN)
