"""Data files for the backtest page (data/local/x/bt/viz/).

  trades.csv     one row per simulated trade: run (bot / random / his), date, stock, return on premium
                 after costs, P&L at the fixed premium, exit rule, carried overnight, and `why`: what
                 the entry rules saw at that minute
  equity.csv     portfolio equity at 2% risk per trade (max 3 open), at each trade's exit, per run
  skips.csv      signals per run by what happened to them
  steps.csv      every buy and sale of each trade (key, day, minute, share, fill price, rule)
  paths.json     per trade and day held: the stock's and the option's 1-min closes (runs in PATH_RUNS)
  liquidity.csv  the option liquidity screen (when it has run)

  python3 export.py bot=data/local/x/bt/bot2024 random=... his=...
"""
import csv, collections, json, os, sys
from store import P, DATA, day, calendar
import report
from signals import Day

PATH_RUNS = {"bot", "his"}

out = os.path.join(DATA, "viz")
os.makedirs(out, exist_ok=True)
runs = dict(a.split("=", 1) for a in sys.argv[1:])
U = P["size"]["fixed_premium"]
T, E, K, ST, PA = [], [], [], [], []
cal = calendar()
for run, prefixes in runs.items():
    trades, steps = [], {}
    for prefix in prefixes.split(","):
        t, s, _ = report.load(prefix)
        trades += t; steps.update(s)
    ok = [t for t in trades if t["status"] == "ok"]
    rets = {t["_i"]: report.ret_at(steps[t["_i"]], report.SH) for t in ok}
    for t in ok: t["_big"] = report.big(t)
    for t in sorted(ok, key=lambda t: (t["date"], int(t["minute"]))):
        r = rets[t["_i"]]
        key = f"{run}-{len(T)}"
        dd = Day(t["sym"], t["date"], 1 if t["right"] == "C" else -1, cal, cal.index(t["date"]))
        why = dd.why(int(t["minute"])) if dd.ok else ""
        T.append(dict(key=key, run=run, date=t["date"], month=t["date"][:7], sym=t["sym"], right=t["right"], time=t["time"],
                      contract=t["contract"], strike=t["strike"], expiry=t["expiry"], dte=t["dte"], delta=t.get("delta", ""),
                      entry=t["entry"], iv=t.get("iv", ""), big=int(t["_big"]), ret=round(r, 4),
                      pnl=round(r * (P["size"]["big"]["fixed_premium"] if t["_big"] else U)), carried=t["carried"], exit_rule=t["exit_rule"],
                      exit_date=t["exit_date"], why=why))
        st = steps[t["_i"]]
        for x in st:
            ST.append(dict(key=key, date=x["date"], minute=x["minute"], side=x["side"], share=x["share"], price=x["price"], rule=x["rule"]))
        if run in PATH_RUNS:
            days = [d for d in cal if t["date"] <= d <= t["exit_date"]]
            for d in days:
                sb = day(t["sym"], d); ob = day(t["contract"], d)
                PA.append(dict(key=key, date=d,
                               stock=";".join(f"{b[0]},{b[4]:.5g}" for b in sb),
                               option=";".join(f"{b[0]},{b[4]:.4g}" for b in ob)))
    eq = P["size"]["start_equity"]
    _, pnl, _ = report.portfolio(ok, rets)
    order = sorted(ok, key=lambda t: (t["date"], int(t["minute"])))
    ev = sorted(((t["exit_date"], int(t["exit_minute"]), p) for t, p in zip(order, pnl) if p is not None))
    E.append(dict(run=run, date=order[0]["date"] if order else "", equity=round(eq)))
    for d, m, p in ev:
        eq += p
        E.append(dict(run=run, date=d, equity=round(eq)))
    for k, n in collections.Counter(t["status"] for t in trades).items():
        K.append(dict(run=run, reason=k, signals=n))


def write(name, rows):
    with open(os.path.join(out, name), "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(name, len(rows))


write("trades.csv", T); write("equity.csv", E); write("skips.csv", K); write("steps.csv", ST)
with open(os.path.join(out, "paths.json"), "w") as f:
    json.dump(PA, f, separators=(",", ":"))
print("paths.json", len(PA), os.path.getsize(os.path.join(out, "paths.json")) // 1024, "KB")
liq = os.path.join(DATA, "liquidity.csv")
if os.path.exists(liq):
    write("liquidity.csv", list(csv.DictReader(open(liq))))
