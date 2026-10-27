"""The Main bot's (Indi) contracts to price with real quotes, the fair list (export_bench.py's signals: HIS40 stocks,
the news filter, versions 2.4 and 2.5): every strike the picker scans at each signal (the fallbacks pick among them),
from the signal minute to the close, then every session after it up to the expiry (the bot holds overnight).
-> indi_dbx_list.csv (date, contract, minute). node --env-file=.env <dir>/run.mjs indi_dbx_list.py (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import cheap_up as cu
import news_filter as nf
from store import calendar
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
CAL = calendar()


def one(t):
    m, date = int(t["minute"]), t["date"]
    out = []
    for c in cu.candidates(t["sym"], date, m, t["right"], float(t["price"])):
        out.append((date, c[0], m))
        for d in CAL[CAL.index(date) + 1:]:
            if d > c[1]: break
            out.append((d, c[0], 0))
    return out


def main():
    T = []
    for prefix in ("s_t18r15", "sg_c12_15"):
        T += [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
    sig = {(t["date"], t["sym"], t["minute"], t["right"]): t for t in T}
    with mp.Pool(8) as pool: res = pool.map(one, list(sig.values()), chunksize=8)
    best = {}
    for date, c, m in (r for rs in res for r in rs): best[(date, c)] = min(m, best.get((date, c), 999))
    with open(os.path.join(HERE, "indi_dbx_list.csv"), "w") as f:
        w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(sorted((d, c, m) for (d, c), m in best.items()))
    print(len(sig), "signals,", len(best), "contract-days on", len({d for d, _ in best}), "days")


if __name__ == "__main__": main()
