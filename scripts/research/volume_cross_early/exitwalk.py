# Exit study on the stock (the user, 2026-11-07: "Lets do an exit study. I want it to be on the stock movement but
# remember that its a valotile moments when the volume surge. Also I can accept lower mony if its caused by exit a
# gaint or to. I neet to increase the precentile"). Re-walks every trade of a run on the D1 snapshot (stock minute
# closes, option minute books and bars), as walkExit + stopHit + bookAt in strangle/backtest.ts, then writes the run
# with the new exits to <runs>/<run>@<exit>/parts for capacct.ts. Variants set before the run (units = the stock's
# typical 30-minute move; G = today's 30-minute grace, during which nothing sells but the -80% stop):
#   now   today's exit (the check: must reproduce the engine's sale on every trade)
#   S10 / S15 / S20  in the grace, sell when the stock closes 1.0 / 1.5 / 2.0 units against the price at the side
#   TF    in the grace, sell when the stock closes past the other side's line (the alert's price -/+ 0.25 unit)
#   G15   the grace 15 minutes, not 30
#   GW    in the grace, the give-back at 1.5 units (0.75 after)
#   NP    at +10 minutes, sell if the stock has not closed 0.5 unit the side's way since the buy
#   python3 exitwalk.py <runDir> <run> [<run> ...]
import json, glob, os, sys, sqlite3, gzip, base64, datetime
from zoneinfo import ZoneInfo
R = sys.argv[1]
db = sqlite3.connect(f"{R}/../d1.sqlite")
NY = ZoneInfo("America/New_York")
def unpack(raw):
    return json.loads(gzip.decompress(base64.b64decode(raw[3:])) if raw.startswith("gz:") else raw)
_bars = {}
def stock(sym, date):
    k = (sym, date)
    if k not in _bars:
        row = db.execute("select bars from minute_bars where key=? and date=?", (f"{sym}:sip:1Min:raw", date)).fetchone()
        d = datetime.date.fromisoformat(date)
        t0 = datetime.datetime(d.year, d.month, d.day, 9, 30, tzinfo=NY).timestamp()
        _bars[k] = {int((r[0] - t0) // 60): r[4] for r in unpack(row[0])} if row else {}
    return _bars[k]
def quotes(c, date):
    rows = db.execute("select source, quotes from option_quotes where contract=? and date=?", (c, date)).fetchall()
    rows.sort(key=lambda r: r[0] != "databento")
    return unpack(rows[0][1]) if rows else []
def obars(c, date):
    row = db.execute("select bars from option_bars where contract=? and date=?", (c, date)).fetchone()
    return unpack(row[0]) if row else []
def book_at(q, m):
    best = None
    for r in q:
        if r[0] > m: break
        best = r
    return best if best and m - best[0] < 5 else None

def walk(rule, closes, b0, side, stock_in, alert_price, unit, end):
    sg = 1 if side == "C" else -1
    best = stock_in
    grace = 15 if rule == "G15" else 30
    for t in range(b0 + 1, end + 1):
        spot = closes.get(t)
        if spot: best = max(best, spot) if sg == 1 else min(best, spot)
        in_grace = t - b0 <= grace and t < end
        if in_grace and spot:
            against = -sg * (spot / stock_in - 1) / unit
            if rule == "S10" and against >= 1.0: return t
            if rule == "S15" and against >= 1.5: return t
            if rule == "S20" and against >= 2.0: return t
            if rule == "TF" and -sg * (spot / alert_price - 1) / unit >= 0.25: return t
            if rule == "GW" and abs(spot / best - 1) >= 1.5 * unit: return t
            if rule == "NP" and t - b0 == 10 and sg * (best / stock_in - 1) / unit < 0.5: return t
        if in_grace: continue
        if t >= end: return t
        if spot and abs(spot / best - 1) >= 0.75 * unit: return t
    return end

RULES = ["now", "S10", "S15", "S20", "TF", "G15", "GW", "NP"]
for run in sys.argv[2:]:
    files = sorted(glob.glob(f"{R}/{run}/parts/*.json"))
    outs = {r: [] for r in RULES}
    miss = bad = n = 0
    for f in files:
        part = json.load(open(f))
        for r in RULES: outs[r].append((os.path.basename(f), json.loads(json.dumps(part))))
        for i, s in enumerate(part["signals"]):
            t = s.get("trade")
            if not t: continue
            n += 1
            ct = t["sideSecond"] // 60
            ob = obars(t["contract"], s["date"])
            b0 = next((b[0] for b in ob if ct <= b[0] <= ct + 3), ct)
            closes = stock(s["symbol"], s["date"])
            q = quotes(t["contract"], s["date"])
            end = 360
            for r in RULES:
                ex = walk(r, closes, b0, t["right"], t["stockIn"], s["price"], s["unit"], end)
                stop = next((x for x in q if ct < x[0] < ex and x[1] <= t["buy"] * 0.2), None)
                m, sale = (stop[0], stop) if stop else (ex, book_at(q, ex))
                tt = outs[r][-1][1]["signals"][i]["trade"]
                if sale is None:
                    miss += 1
                    continue
                if r == "now" and (m != t["exitMinute"] or abs(sale[1] - t["sell"]) > 1e-9):
                    bad += 1
                    if bad <= 5: print("mismatch", s["id"], m, t["exitMinute"], sale[1], t["sell"], t["exitReason"])
                tt["exitMinute"], tt["sell"] = m, sale[1]
    print(f"{run}: {n} trades, today's exit reproduced on {n - bad}, no book at a new exit: {miss}")
    for r in RULES[1:]:
        os.makedirs(f"{R}/{run}@{r}/parts", exist_ok=True)
        for name, part in outs[r]:
            json.dump(part, open(f"{R}/{run}@{r}/parts/{name}", "w"))
