"""Step 6 of the trader study: data for the chart review page. For the biggest winners and a
spread of losers it collects the stock's and SPY's regular-session 1-min bars on each day the
trade was open, the option's bars, and his steps with their posts.

  python3 scripts/research/indi-review.py <data dir> <out.json> [n_winners] [n_losers]
Losers are spread evenly over the losing trades sorted by P&L (not just the worst).
"""
import csv, json, sqlite3, sys, collections, datetime as dt
from zoneinfo import ZoneInfo

d, out = sys.argv[1], sys.argv[2]
nw = int(sys.argv[3]) if len(sys.argv) > 3 else 10
nl = int(sys.argv[4]) if len(sys.argv) > 4 else 10
NY = ZoneInfo("America/New_York")
PROXY = {"SPXW": "SPY", "NDXP": "QQQ"}
db = sqlite3.connect(f"{d}/bars.sqlite")
M = {r["trade"]: r for r in csv.DictReader(open(f"{d}/manage.csv"))}
F = collections.defaultdict(list)
for r in csv.DictReader(open(f"{d}/features.csv")):
    F[r["trade"]].append(r)


def rth(sym, date):
    row = db.execute("SELECT bars FROM bars WHERE symbol=? AND date=?", (sym, date)).fetchone()
    res = []
    for b in json.loads(row[0]) if row else []:
        t = dt.datetime.fromtimestamp(b[0], NY)
        if 570 <= t.hour * 60 + t.minute < 960:
            res.append([b[0], round(b[1], 4), round(b[2], 4), round(b[3], 4), round(b[4], 4), int(b[5])])
    return res


def occ(und, expiry, strike, right):
    return f"{und}{expiry[2:4]}{expiry[5:7]}{expiry[8:10]}{right}{round(strike * 1000):08d}"


rows = list(csv.DictReader(open(f"{d}/actions.csv")))
by = collections.defaultdict(list)
for r in rows:
    if r["account"] == "silexx" and not r["contract"].endswith("S"):
        by[r["trade"]].append(r)
res = [t for t in by if t in M and M[t]["pnl"] not in ("", None)]
res.sort(key=lambda t: -float(M[t]["pnl"]))
winners = res[:nw]
losers_all = [t for t in res if float(M[t]["pnl"]) <= 0]
step = max(1, len(losers_all) // nl)
losers = losers_all[::step][:nl]
pick = [(t, "winner") for t in winners] + [(t, "loser") for t in losers]
data = []
for t, group in pick:
    steps = by[t]
    und, expiry, sr = steps[0]["contract"].rsplit(" ", 2)
    sym = PROXY.get(und, und)
    days = sorted({s["date"] for s in steps})
    last_day = days[-1]
    if steps[-1]["action"].startswith("expired") and len(days) > 1:
        days = days[:-1] + [last_day]
    ob = []
    for (b,) in db.execute("SELECT bars FROM bars WHERE symbol=? ORDER BY date",
                           (occ(und, expiry, float(sr[:-1]), sr[-1]),)):
        ob += [[x[0], round(x[4], 4), int(x[5])] for x in json.loads(b)]
    lo, hi = None, None
    stock = {dd: rth(sym, dd) for dd in days}
    spy = {dd: rth("SPY", dd) for dd in days} if sym != "SPY" else {}
    feats = {(f["date"], f["time"]): {k: f[k] for k in ("ex15", "ex_open", "rvol15", "burst", "range_pos", "vs_vwap", "otm", "dte")}
             for f in F[t]}
    data.append(dict(trade=t, group=group, und=und, sym=sym, contract=steps[0]["contract"], right=sr[-1],
                     pnl=float(M[t]["pnl"]), ret=M[t].get("ret"), manage={k: M[t].get(k) for k in
                     ("hold_min", "first_cut_pct", "first_cut_min", "mae_pct", "mfe_pct", "after_best_pct", "after_last_pct")},
                     days=days, stock=stock, spy=spy,
                     option=[x for x in ob if days[0] <= dt.datetime.fromtimestamp(x[0], NY).date().isoformat() <= days[-1]],
                     steps=[dict(date=s["date"], time=s["time_from"], action=s["action"], side=s["side"], qty=int(s["qty"]),
                                 price=float(s["avg_price"]), pos=s["position_after"], pnl=s["realized_step"],
                                 post=s["his_post"], f=feats.get((s["date"], s["time_from"]))) for s in steps]))
json.dump(data, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
print(len(data), "trades:", ", ".join(f"{x['und']} {x['pnl']:+,.0f}" for x in data))
