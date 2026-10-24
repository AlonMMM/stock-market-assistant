"""Writes the "sold, then it ran" trades (missed_runs.py, the 10-second cadence) as a lists.py-shaped file, so
export_lists.py can put them on the Backtest Reports dashboard as the list `sold_ran`.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs missed_runs_list.py [min gain %, default 100]
  -> data/local/x/bt/list_sold_ran_<A>_<Z>.json
"""
import csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import exits_10s as E
import missed_runs as M
import sim
import news_filter as nf

MIN = float(sys.argv[1]) / 100 if len(sys.argv) > 1 else 1.0
NAME = "sold_ran"


def row(t):
    cost, steps, _ = E.walk(t, True)
    if cost is None: return None
    sold = sum(s[3] for s in steps if s[2] == "sell")
    return dict(t, list=NAME, status="bought", cost=round(cost, 4), ret=round(sim.result(cost, steps), 4) if sold >= 0.999 else None,
                open_share=round(1 - sold, 2), strike=float(t["contract"][-8:]) / 1000,
                steps=";".join(f"{s[0]} {s[1]} {s[2]} {s[3]:.2f} @{s[4]:.4f} {s[5]}" for s in steps[1:]))


def main():
    A, Z, SYMS = E.ten_window()
    T = [t for f in glob.glob(f"{E.B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and A <= t["date"] <= Z and t["sym"] in SYMS),
               key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = [r for r in pool.map(M.one, T, chunksize=4) if r]
    hit = {(r["sym"], r["date"], r["minute"]) for r in R if r["10-s"]["hi"] and r["10-s"]["hi"][0] >= MIN}
    picked = [t for t in T if (t["sym"], t["date"], int(t["minute"])) in hit]
    out = [r for r in (row(t) for t in picked) if r]
    for r in out:
        for k in ("e_next", "pre_rvol"): r.pop(k, None)
    path = f"{E.B}/list_{NAME}_{A}_{Z}.json"
    json.dump(out, open(path, "w"), default=str, indent=1)
    print(len(out), "trades ->", path)


if __name__ == "__main__":
    main()
