"""The t-stat exit champion (2026-10-24) for the Bot vs Indi dashboard: the champion's fair-list trades walked with the
t-stat exit (signal t <= 0.5 on the entry day sells all; -30% stop, your stop, overnight hold; no failed break), in
the dashboard's trades / paths file shapes (5-minute closes, as the page draws them). Appends to the downloaded
current files when given.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs export_tstat.py <out dir> [trades.csv paths.csv to append to]
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import calendar, day
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
CAL = calendar()
X0 = {**sim.X, **H, **NIGHT, "thesis": {"t": 0.5}}
# BT_HOLD (e.g. 0.5): the overnight hold from that gain; BT_SLUG / BT_NAME name the version (defaults: the t-stat exit at +100%)
if os.environ.get("BT_HOLD"): X0["carry_min_gain"] = float(os.environ["BT_HOLD"])
# BT_REST (e.g. -0.2): the rest out at that gain once the +10 check sold half (sim.py after_half)
if os.environ.get("BT_REST"): X0["after_half"] = dict(out=float(os.environ["BT_REST"]))
SLUG = os.environ.get("BT_SLUG", "t18-tstat")
NAME = os.environ.get("BT_NAME", "Champion: t ≥ 1.8 + news filter + t-stat exit, delta 0.15")
PER = 78
WORDS = {"U_check10": "Stop: 10-min check", "U_check20": "Stop: 20-min check", "U_out": "Stop: -30%", "eod_close": "Sold 15:50",
         "morning_gap_keep": "sold half next morning", "morning_gap_against": "sold next morning", "expiry_day": "expiry day",
         "day_end_forced": "Day end", "expired": "expired", "T_tstat": "Thesis: strength vs SPY gone", "U_rest": "Stop: the rest at -20% after the half", "eod_close_late": "Sold 15:50"}


def words(steps):
    sells = [s for s in steps if s[2] == "sell"]
    last = sells[-1]
    w = WORDS.get(last[5].replace("_late", ""), last[5])
    if any(s[2] == "carry" for s in steps):
        return "Held overnight, " + (w if w.startswith("sold") else "then " + w[0].lower() + w[1:])
    return w


def closes5(bars):
    out = [""] * PER
    for b in bars: out[min(PER - 1, b[0] // 5)] = f"{b[4]:.5g}"
    return out


def one(t):
    sim.X.clear(); sim.X.update(X0)
    m0 = int(t["minute"])
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], t["contract"], t["expiry"], CAL)
    if cost is None: return None
    key = f"{SLUG}-{t['date']}-{t['sym']}-{t['right']}-{m0}"
    last = [s for s in steps if s[2] == "sell"][-1]
    row = dict(version=SLUG, version_name=NAME, key=key, date=t["date"], time=t["time"], minute=m0, sym=t["sym"], right=t["right"],
               contract=t["contract"], iv=t.get("iv", ""), ret=round(sim.result(cost, steps), 4), exit=words(steps), overnight=int(last[0] != t["date"]))
    days = [d for d in CAL if t["date"] <= d <= last[0]]
    opt = "|".join(f"{d}: " + " ".join(closes5([b for b in day(t["contract"], d) if d != t["date"] or b[0] >= m0])) for d in days)
    after = "|".join(f"{d}: " + " ".join(closes5(day(t["sym"], d))) for d in days[1:])
    path = dict(key=key, cost=round(cost, 4), steps=";".join(f"{s[0]},{s[1]},{s[2]},{s[3]},{s[4]},{s[5]}" for s in steps), option=opt, stock_after=after)
    return row, path


def main():
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]),
               key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = [r for r in pool.map(one, T, chunksize=8) if r]
    rows, paths = [r[0] for r in R], [r[1] for r in R]
    base_t = list(csv.DictReader(open(sys.argv[2]))) if len(sys.argv) > 3 else []
    base_p = list(csv.DictReader(open(sys.argv[3]))) if len(sys.argv) > 3 else []
    base_t = [r for r in base_t if r["version"] != SLUG]; base_p = [r for r in base_p if not r["key"].startswith(SLUG + "-")]
    names = (os.environ.get("BT_OUT_TRADES", "trades5.csv"), os.environ.get("BT_OUT_PATHS", "paths4.csv"))
    for name, data in ((names[0], base_t + rows), (names[1], base_p + paths)):
        with open(f"{out}/{name}", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys())); w.writeheader(); w.writerows(data)
        print(name, len(data), "rows", os.path.getsize(f"{out}/{name}") // 1024, "KB")
    print(len(rows), "trades of", SLUG, "; exits:", sorted({r["exit"] for r in rows}))


if __name__ == "__main__":
    main()
