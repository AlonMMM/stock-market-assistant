"""How SPY's move while a trade is open drags the bot's trades (the user, 2026-10-29: "help me understand how spy goes
down and take with it our winners, affect on us?"). Analysis only (no check look).

Every champion main trade (retry_roll.py's base, real quotes): fair list + Favorites (favorites.txt), all weeks. SPY's
move from the entry minute to the last sale, on the trade's side (a call: SPY down is against), the stock's own move the
same way, the option's best gain while held (1-minute closes, the bid ~ close less the spread) and the final result.
Per SPY bucket, by half: trades, winners, the median and the sum at $10K, giants (+300%+), the rest's sum; the winners
that gave back (up +100% at their best, ended under +50%); the nights (15:50 -> 09:40 SPY gap on the trade's side).

  node --env-file=.env <dir>/run.mjs spy_drag.py      (from the app repo root)
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half
from store import day

B = "data/local/x/bt"


def px(sym, d, m):
    c = rr.closes(sym, d)
    for k in range(min(m, 389), -1, -1):
        if c[k]: return c[k]
    return None


def one(job):
    src, t = job
    if src == "fav" and t["date"] < FR.A24: return None
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    rcost, real, _ = g
    sells = [s for s in real if s[2] == "sell"]
    if not sells: return None
    end = max((s[0], s[1]) for s in sells)
    bet = 1 if right == "C" else -1
    s0, s1, q0, q1 = px("SPY", date, m0), px("SPY", *end), px(sym, date, m0), px(sym, *end)
    if not (s0 and s1 and q0 and q1): return None
    peak = 0.0
    for d in [d for d in rr.CAL if date <= d <= end[0]]:
        for b in day(c[0], d):
            if (d, b[0]) <= (date, m0) or (d, b[0]) > end: continue
            peak = max(peak, b[4] * (1 - sim.SH) / rcost - 1)
    nights = []
    for s in real:
        if s[2] != "carry": continue
        nd = rr.CAL[rr.CAL.index(s[0]) + 1]
        a, b = px("SPY", s[0], s[1]), px("SPY", nd, 10)
        ob = [x for x in day(c[0], nd) if x[0] <= 10]
        if a and b and ob: nights.append((bet * (b / a - 1), ob[-1][4] / s[4] - 1, s[3] * s[4] / rcost))
    return dict(src=src, half=half(date), date=date, sym=sym, right=right, spy=bet * (s1 / s0 - 1), stock=bet * (q1 / q0 - 1),
                peak=peak, r=sim.result(rcost, real, 0.02), nights=nights)


def main():
    jobs = [("fair", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25")]
    with mp.Pool(8) as pool: T = [x for x in pool.map(one, jobs, chunksize=4) if x]
    json.dump(T, open(f"{B}/spy_drag.json", "w"))
    BK = (("SPY against us > 1%", lambda v: v < -0.01), ("against 0.3-1%", lambda v: -0.01 <= v < -0.003), ("flat (+-0.3%)", lambda v: -0.003 <= v < 0.003),
          ("with us 0.3-1%", lambda v: 0.003 <= v < 0.01), ("with us > 1%", lambda v: v >= 0.01))
    for src in ("fair", "fav"):
        print(f"\n#### {src}: SPY's move while the trade was open (on the trade's side), $ at $10K\n\n| SPY | Half | Trades | Winners | Median | Sum | Giants (sum) | The rest | Stock our way (median) | Up +100% then ended < +50% |\n|---|---|---|---|---|---|---|---|---|---|")
        for lab, f in BK:
            for part in ("tune", "check"):
                X = [x for x in T if x["src"] == src and x["half"] == part and f(x["spy"])]
                if not X: continue
                v = [1e4 * max(-1, x["r"]) for x in X]; g = [a for a in v if a >= 3e4]
                big = [x for x in X if x["peak"] >= 1]; gave = [x for x in big if x["r"] < 0.5]
                print(f"| {lab} | {part} | {len(X)} | {sum(a > 0 for a in v) / len(v):.0%} | {st.median(v):+,.0f} | {sum(v):+,.0f} | {len(g)} ({sum(g):+,.0f}) | {sum(v) - sum(g):+,.0f} | "
                      f"{st.median(x['stock'] for x in X):+.1%} | {len(gave)} of {len(big)} |", flush=True)
        N = [n for x in T if x["src"] == src for n in x["nights"]]
        print(f"\n{src} nights held: {len(N)}")
        for lab, f in (("SPY gap against > 0.5%", lambda v: v < -0.005), ("SPY gap against 0-0.5%", lambda v: -0.005 <= v < 0), ("SPY gap with 0-0.5%", lambda v: 0 <= v < 0.005), ("SPY gap with > 0.5%", lambda v: v >= 0.005)):
            Y = [n for n in N if f(n[0])]
            if Y: print(f"  {lab}: {len(Y)} nights, winning {sum(n[1] > 0 for n in Y)}, median night {st.median(n[1] for n in Y):+.0%}, sum at $10K {sum(1e4 * n[2] * n[1] for n in Y):+,.0f}")


if __name__ == "__main__":
    main()
