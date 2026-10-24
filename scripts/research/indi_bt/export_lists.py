"""Data files for the Backtest Reports dashboard, from lists.py runs (data/local/x/bt/list_<name>_<A>_<Z>.json).

  trades.csv   one row per bought trade: list, key, date, time, minute, sym, right, contract, strike, expiry, dte, delta, iv,
               price (the stock's close on the signal minute, the entry the checks compare with), cost, ret, exit (words), overnight
  funnel.csv   per list: signals, skipped by the news filter, no contract, no fill, bought
  bars.csv     1-minute closes of each trade's stock on the day before and the trade day, and SPY on those days
               (key "SYM|date", 390 slots a day, blank where no bar)
  paths.csv    per trade: the paid price, every fill (day,minute,side,share,price,rule; ...), the option's 1-minute closes
               per day held ("date: c c c|date2: ..."), and the stock's closes on carried days

  python3 export_lists.py <A> <Z> <name> [<name> ...]     (from the repo root) -> data/local/x/bt/viz_lists/
  A name may carry its own range, <name>@<A>_<Z> (e.g. semis_fb@2025-10-23_2026-10-22), to export studies of
  different periods together.
"""
import csv, datetime as dt, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import day, calendar

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


def closes5(bars):
    """PER slots of closes from 1-minute bars (minute, o, h, l, c, v), one a minute; '' where the minute has no bar."""
    out = [""] * PER
    for b in bars:
        k = min(PER - 1, b[0] * PER // 390)
        out[k] = f"{b[4]:.5g}"
    return out


cal = calendar()
T, F, PA, keys = [], [], [], set()
for spec in NAMES:
    name, _, rng = spec.partition("@")
    W = json.load(open(f"{B}/list_{name}_{rng or f'{A}_{Z}'}.json"))
    n = {"signals": len(W), "skipped": 0, "no_contract": 0, "no_fill": 0, "bought": 0}
    for r in W:
        s = r["status"].split(":")[0].replace(" ", "_")
        n[s] = n.get(s, 0) + 1
    F.append(dict(list=name, **n))
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
        PA.append(dict(key=key, cost=r["cost"], steps=";".join(",".join(f) for f in fills), option=opt, stock_after=after))
        i = cal.index(r["date"])
        for sym in (r["sym"], "SPY"): keys.add((sym, r["date"], cal[i - 1]))

BARS = [dict(key=f"{sym}|{d}", prev_date=pd, closes=" ".join(closes5(day(sym, pd)) + closes5(day(sym, d)))) for sym, d, pd in sorted(keys)]


def write(fname, rows):
    with open(f"{OUT}/{fname}", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(fname, len(rows), os.path.getsize(f"{OUT}/{fname}") // 1024, "KB")


write("trades.csv", T); write("funnel.csv", F); write("bars.csv", BARS); write("paths.csv", PA)
