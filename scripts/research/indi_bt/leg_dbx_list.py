"""The contracts to price with real quotes (Databento OPRA cbbo-1m): every strike the Volume bot's picker scans at
each side (the live rule: 0DTE + 1DTE, side at 0.25 S30 in 10 minutes), 3 years. -> dbx_list.csv (date, contract,
side minute). BT_UNIVERSE=watch BT_ALL=1 node --env-file=.env <path>/run.mjs leg_dbx_list.py
"""
import csv, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day
from levels import ctx
from rvol_alert import alerts_for
from zero5 import FIRST, LAST
from cheap_up import candidates
import leg_twice as TW

C = sim.C
CAL = TW.CAL


def one(job):
    date, sym, kind = job
    al = alerts_for(sym, date, CAL)
    if not al: return []
    ev = [q for q in range(FIRST, LAST + 1) if al[q] and not al[q - 1]]
    sb = {b[0]: b for b in day(sym, date)}
    x = ctx(sym, date)
    if not ev or not x or not x.get("sd"): return []
    u = x["sd"]
    if kind == "0": C.update(dte_min=0, dte_max=0, delta=0.35)
    else: C.update(dte_min=1, dte_max=5, delta=0.35)
    nxt = CAL[CAL.index(date) + 1] if kind == "1" else date
    out = []
    for m in ev:
        if m not in sb: continue
        stock0 = sb[m][4]
        for t in range(m + 1, m + TW.WAIT + 1):
            if t in sb and abs(sb[t][4] / stock0 - 1) >= TW.K * u:
                right = "C" if sb[t][4] > stock0 else "P"
                got, why = sim.pick(sym, date, t, right, sb[t][4])
                if why not in ("no_expiry", "no_strikes"):
                    out += [(date, c[0], t) for c in candidates(sym, date, t, right, sb[t][4]) if c[1] == nxt]
                break
    return out


def main():
    jobs = TW.days()
    with mp.Pool(8) as pool: res = pool.map(one, jobs, chunksize=4)
    rows = sorted({r for rs in res for r in rs})
    with open(os.path.join(HERE, "dbx_list.csv"), "w") as f:
        w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
    print(len(rows), "contract-sides on", len({r[0] for r in rows}), "days")


if __name__ == "__main__": main()
