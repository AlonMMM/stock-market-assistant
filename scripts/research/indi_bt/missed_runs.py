"""Sold, then it ran: the champion-bot trades of the 10-second window that were sold on the entry day while the option
went on to a big gain the same day (the user's question, 2026-10-24: "show me all the stocks that we sold and would run
to big winners"). Both cadences of exits_10s.py (once a minute = the champion-bot backtest, every 10 s = the live bot).
"Ran to": the option's highest minute close after the sale, up to 15:50, and its 15:50 close, against what we paid.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs missed_runs.py [min gain %, default 100]
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import exits_10s as E
import sim
import news_filter as nf
from store import day

MIN = float(sys.argv[1]) / 100 if len(sys.argv) > 1 else 1.0
EOD = 380


def il(minute):
    h, m = divmod(int(970 + minute), 60)  # 09:30 NY = 16:30 Israel in the usual overlap
    return f"{h:02d}:{m:02d}"


def one(t):
    out = dict(sym=t["sym"], date=t["date"], right=t["right"], minute=int(t["minute"]), contract=t["contract"])
    bars = day(t["contract"], t["date"])
    for v, ten in (("1-min", False), ("10-s", True)):
        cost, steps, _ = E.walk(t, ten)
        if cost is None: return None
        sales = [s for s in steps if s[2] == "sell" and s[0] == t["date"]]
        carried = any(s[2] == "carry" for s in steps)
        last = max((s[1] for s in sales), default=None)
        ret = sim.result(cost, steps)
        after = [b for b in bars if last is not None and b[0] > last and b[0] <= EOD] if not carried else []
        hi = max(after, key=lambda b: b[4]) if after else None
        at_eod = next((b for b in bars if b[0] >= EOD), None)
        out[v] = dict(ret=ret, carried=carried, last=last, rules="|".join(s[5] for s in sales),
                      hi=(hi[4] / cost - 1, hi[0]) if hi else None, eod=(at_eod[4] / cost - 1) if at_eod and not carried else None)
    return out


def main():
    A, Z, SYMS = E.ten_window()
    T = [t for f in glob.glob(f"{E.B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and A <= t["date"] <= Z and t["sym"] in SYMS),
               key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = [r for r in pool.map(one, T, chunksize=4) if r]
    for v in ("10-s", "1-min"):
        hits = [r for r in R if r[v]["hi"] and r[v]["hi"][0] >= MIN]
        hits.sort(key=lambda r: -r[v]["hi"][0])
        sold = [r for r in R if not r[v]["carried"] and r[v]["last"] is not None]
        print(f"\n### {v}: {len(hits)} of {len(sold)} trades sold on the entry day went on to +{100 * MIN:.0f}% or more the same day (of {len(R)} trades)\n")
        print("| Stock | Date | In (IL) | Sold (IL), rule | Our result | Then up to | at (IL) | At 15:50 | Other cadence |\n|---|---|---|---|---|---|---|---|---|")
        o = "1-min" if v == "10-s" else "10-s"
        for r in hits:
            x, y = r[v], r[o]
            other = "same" if abs(y["ret"] - x["ret"]) < 0.005 else f"{100 * y['ret']:+.0f}% ({'held overnight' if y['carried'] else y['rules']})"
            print(f"| {r['sym']} {r['right']} | {r['date']} | {il(r['minute'])} | {il(x['last'])}, {x['rules']} | {100 * x['ret']:+.0f}% | "
                  f"{100 * x['hi'][0]:+.0f}% | {il(x['hi'][1])} | {100 * x['eod']:+.0f}% | {other} |" if x["eod"] is not None else
                  f"| {r['sym']} {r['right']} | {r['date']} | {il(r['minute'])} | {il(x['last'])}, {x['rules']} | {100 * x['ret']:+.0f}% | {100 * x['hi'][0]:+.0f}% | {il(x['hi'][1])} | ? | {other} |")
        missed = sum(1e4 * (min(r[v]["eod"], 1e9) - max(-1, r[v]["ret"])) for r in hits if r[v]["eod"] is not None)
        print(f"\nHad these been held to 15:50 instead: {missed:+,.0f} at $10K a trade over the {len(hits)} (vs what we made on them: "
              f"{sum(1e4 * max(-1, r[v]['ret']) for r in hits):+,.0f}).")


if __name__ == "__main__":
    main()
