"""What the pre-market says about the champion's trades (the user, 2026-10-28: "Yes" to the diagnostic; "agree" = the
stock's pre-market moving the trade's way). Analysis only, the tune weeks only (split.py), no check look.

Every champion main trade (retry_roll.py's base: fair list + Favorites 24m, real quotes), its stock's pre-market 08:00-
09:29 New York (premarket_d2.signal(): t vs SPY x beta over the pre-market minutes, D2 over its last 30, the pre-market
volume over its median of the 20 sessions before), on the trade's side; the pre-market move = the last pre-market close
over the day before's close, in the stock's S30 units, on the trade's side; liquid at the open = the trade's contract
traded 200+ contracts 09:30-09:35. Per bucket: trades, winners, $ per trade and the sum at $10K (2% sizing's returns,
the 10% overnight cap), and the sum without the bucket's best 3.

  node --env-file=.env <dir>/run.mjs pre_agree.py      (from the app repo root)
"""
import json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import premarket_d2 as pd
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half
from store import day


def one(job):
    src, t = job
    if (os.environ.get("PA_ALL") != "1" and half(t["date"]) != "tune") or (src == "fav" and t["date"] < FR.A24): return None
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    bet = 1 if right == "C" else -1
    out = dict(half=half(date), src=src, date=date, sym=sym, right=right, minute=m0, r=sim.result(g[0], g[1], 0.02))
    pm = pd.signal((sym, date))
    if pm: out.update(t=bet * pm["t"], d2=pm["d2c"] if bet > 0 else pm["d2p"], rv=pm["rv"])
    pre = [x for x in pd.prem(sym, date) if x]
    i = rr.CAL.index(date); prev = day(sym, rr.CAL[i - 1]); cx = pd.ctx(sym, date)
    if pre and prev and cx and cx["sd"]: out["move"] = bet * (pre[-1] / prev[-1][4] - 1) / cx["sd"]
    out["liq_open"] = sum(b[5] for b in day(c[0], date) if b[0] <= 5) >= 200
    return out


def show(T, name, key, buckets):
    print(f"\n#### {name}\n\n| Bucket | Trades (fair / fav) | Winners | $ a trade at $10K | Sum | Sum without the best 3 |\n|---|---|---|---|---|---|")
    for lab, f in buckets:
        cells = []
        for src in ("fair", "fav"):
            B = sorted((1e4 * max(-1, x["r"]) for x in T if x["src"] == src and key(x) is not None and f(key(x))))
            cells.append(B)
        row = [f"{len(b)}" for b in cells], [f"{sum(v > 0 for v in b) / max(1, len(b)):.0%}" for b in cells], \
              [f"{st.fmean(b):+,.0f}" if b else "—" for b in cells], [f"{sum(b):+,.0f}" for b in cells], [f"{sum(b[:-3]):+,.0f}" for b in cells]
        print(f"| {lab} | " + " | ".join(" / ".join(x) for x in row) + " |", flush=True)


def main():
    jobs = [("fair", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25")]
    with mp.Pool(8) as pool: T = [x for x in pool.map(one, jobs, chunksize=4) if x]
    json.dump(T, open(f"data/local/x/bt/pre_agree{'_all' if os.environ.get('PA_ALL') == '1' else ''}.json", "w"))
    if os.environ.get("PA_ALL") == "1": return   # PA_ALL=1: both halves, for the why (read by a separate summary)
    print(f"{sum(x['src'] == 'fair' for x in T)} fair / {sum(x['src'] == 'fav' for x in T)} Favorites tune trades; "
          f"with a pre-market reading {sum('t' in x for x in T)}")
    show(T, "All tune trades", lambda x: 0, [("all", lambda v: True)])
    show(T, "Pre-market strength t, on the trade's side", lambda x: x.get("t"),
         [("against (t <= -1)", lambda v: v <= -1), ("neutral (-1 < t < 1)", lambda v: -1 < v < 1), ("with us (1 <= t < 1.8)", lambda v: 1 <= v < 1.8), ("strongly with us (t >= 1.8)", lambda v: v >= 1.8)])
    show(T, "Pre-market D2 (last 30 pre-market minutes), on the trade's side", lambda x: x.get("d2"),
         [("D2 < -1", lambda v: v < -1), ("-1 to 0", lambda v: -1 <= v < 0), ("0 to 1", lambda v: 0 <= v < 1), ("D2 >= 1", lambda v: v >= 1)])
    show(T, "Pre-market move from yesterday's close, S30 units, on the trade's side", lambda x: x.get("move"),
         [("against (< -1)", lambda v: v < -1), ("flat (-1 to 1)", lambda v: -1 <= v < 1), ("our way 1-3", lambda v: 1 <= v < 3), ("our way 3+ (used up?)", lambda v: v >= 3)])
    show(T, "Pre-market volume vs usual", lambda x: x.get("rv"),
         [("< 1x", lambda v: v < 1), ("1-1.5x", lambda v: 1 <= v < 1.5), ("1.5-4x", lambda v: 1.5 <= v < 4)])
    show(T, "The trade's contract traded 200+ in 09:30-09:35", lambda x: x["liq_open"], [("yes", lambda v: v), ("no", lambda v: not v)])
    show(T, "Signal time", lambda x: x["minute"], [("09:40-09:49", lambda v: v < 20), ("09:50-10:59", lambda v: 20 <= v < 90), ("11:00+", lambda v: v >= 90)])


if __name__ == "__main__":
    main()
