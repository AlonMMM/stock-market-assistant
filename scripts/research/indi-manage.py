"""Step 4 of the trader study: how he manages a trade, measured on the option's own 1-min bars.

Per main-account option trade (with an open time), from <dir>/actions.csv and <dir>/bars.sqlite:
  hold          minutes from the open to the final exit, and whether it was held overnight
  first_cut     at his first sell: option % vs his average cost and minutes since the open
  mae / mfe     worst and best option price while he held (low/high of 1-min bars), % vs cost
  after_exit    best option price from his last sell to expiry, and the last price before expiry,
                as % of his exit price (did the exit save money or leave it?)
  result        realized P&L and return on cost (expiries assumed 0 are included)
Option bars are trades; thin contracts have gaps, so the extremes are lower bounds.

  python3 scripts/research/indi-manage.py <data dir>      -> <dir>/manage.csv
"""
import csv, json, sqlite3, sys, collections, datetime as dt
from zoneinfo import ZoneInfo

d = sys.argv[1]
NY = ZoneInfo("America/New_York")
db = sqlite3.connect(f"{d}/bars.sqlite")


def occ(und, expiry, strike, right):
    return f"{und}{expiry[2:4]}{expiry[5:7]}{expiry[8:10]}{right}{round(strike * 1000):08d}"


def option_bars(sym):
    out = []
    for (b,) in db.execute("SELECT bars FROM bars WHERE symbol=? ORDER BY date", (sym,)):
        out += json.loads(b)
    return out


def epoch(date, time):
    return dt.datetime.fromisoformat(f"{date}T{time}").replace(tzinfo=NY).timestamp()


rows = list(csv.DictReader(open(f"{d}/actions.csv")))
by = collections.defaultdict(list)
for r in rows:
    if r["account"] == "silexx" and not r["contract"].endswith("S"):
        by[r["trade"]].append(r)
out = []
for trade, steps in by.items():
    und, expiry, sr = steps[0]["contract"].rsplit(" ", 2)
    opens = [s for s in steps if s["action"] == "open" and s["time_from"]]
    if not opens:
        continue
    o = opens[0]
    sells = [s for s in steps if s["side"] == "S" and not s["action"].startswith("expired")]
    buys = [s for s in steps if s["side"] == "B"]
    cost = sum(int(s["qty"]) * float(s["avg_price"]) for s in buys) / sum(int(s["qty"]) for s in buys)
    total = next((int(s["realized_total"]) for s in reversed(steps) if s["realized_total"]), None)
    bars = option_bars(occ(und, expiry, float(sr[:-1]), sr[-1]))
    t0 = epoch(o["date"], o["time_from"])
    timed_sells = [s for s in sells if s["time_from"]]
    last = timed_sells[-1] if timed_sells else None
    t1 = epoch(last["date"], last["time_from"]) if last else None
    f = dict(trade=trade, und=und, right=sr[-1], date=o["date"], time=o["time_from"], cost=round(cost, 4),
             adds=sum(s["action"] == "add" for s in steps), trims=sum(s["action"] == "trim" for s in steps),
             expired=any(s["action"].startswith("expired") for s in steps), pnl=total,
             ret=round(total / (cost * sum(int(s["qty"]) for s in buys) * 100) * 100, 1) if total is not None else None,
             option_bars=len(bars))
    if last:
        f["hold_min"] = round((t1 - t0) / 60)
        f["overnight"] = last["date"] != o["date"]
    first = next((s for s in sells if s["time_from"]), None)
    if first:
        f["first_cut_pct"] = round((float(first["avg_price"]) / cost - 1) * 100, 1)
        f["first_cut_min"] = round((epoch(first["date"], first["time_from"]) - t0) / 60)
        f["first_cut_qty_share"] = round(int(first["qty"]) / sum(int(s["qty"]) for s in buys), 2)
    if bars and t1:
        held = [b for b in bars if t0 <= b[0] + 60 and b[0] <= t1]
        if held:
            f["mae_pct"] = round((min(b[3] for b in held) / cost - 1) * 100, 1)
            f["mfe_pct"] = round((max(b[2] for b in held) / cost - 1) * 100, 1)
        after = [b for b in bars if b[0] >= t1 + 60]
        px = float(last["avg_price"])
        if after and px > 0:
            f["after_best_pct"] = round((max(b[2] for b in after) / px - 1) * 100, 1)
            f["after_last_pct"] = round((after[-1][4] / px - 1) * 100, 1)
    out.append(f)
keys = list(dict.fromkeys(k for x in out for k in x))
w = csv.DictWriter(open(f"{d}/manage.csv", "w"), fieldnames=keys)
w.writeheader()
w.writerows(out)
print(len(out), "trades;", sum(1 for x in out if x["option_bars"]), "with option bars")
