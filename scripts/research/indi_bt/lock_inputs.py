"""The research walk's own minute inputs for every be_lock sale of an export: the stock's minute close (Day.c) and the
option mark the walk reads (walk_bars: the book's mid each stock minute), plus the cost it decided on -> JSON for the
TS parity check (scripts/bot-lock-parity.ts in the app repo). Run from the app repo root: python3 <this> <export dir>."""
import csv, json, sys
sys.path.insert(0, "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
import sim
from store import calendar
csv.field_size_limit(1 << 30)
d_ = sys.argv[1]; cal = calendar()
P = {r["key"]: r for r in csv.DictReader(open(f"{d_}/early_paths.csv"))}
out = []
for t in csv.DictReader(open(f"{d_}/early_trades.csv")):
    if t["version"] != "champ-1s": continue
    p = P.get(t["key"])
    if not p or ",BE_lock" not in p["steps"]: continue
    steps = [s.split(",") for s in p["steps"].split(";")]
    d, m0, bet = t["date"], int(t["minute"]), 1 if t["right"] == "C" else -1
    sd = sim.Day(t["sym"], d, bet, cal, cal.index(d))
    bars = sim.walk_bars(t["sym"], t["contract"], d, m0, None)
    out.append(dict(key=t["key"], date=d, minute=m0, contract=t["contract"], right=t["right"], cost=float(steps[0][4]),
                    buy=int(steps[0][1]), sold=next(int(s[1]) for s in steps if s[5] == "BE_lock"),
                    rows=[[b[0], b[4], sd.c[min(b[0], 389)]] for b in bars if b[0] > m0]))
json.dump(out, open(f"{d_}/lock_inputs.json", "w"))
print(len(out), "lock trades")
