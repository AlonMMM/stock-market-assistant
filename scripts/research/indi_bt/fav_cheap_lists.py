"""fav_cheap_up.py's three fallbacks written as lists.py result files, so the Backtest Reports dashboard can show them:
list_favorites_23_cheap|liquid|both_<A>_<Z>.json = favorites_23's rows, the too-cheap / illiquid signals that the
fallback turns into a trade filled in as "bought" rows (the live bot 2.3's exits).

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs fav_cheap_lists.py      (from the repo root)
"""
import json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
from fav_cheap_up import A, Z, NAME

MODES = ("cheap", "liquid", "both")


def one(r):
    why = r["status"].partition(":")[2].strip()
    if why not in ("too_cheap", "illiquid"): return r["id"] if "id" in r else None, {}
    minute, spot = int(r["minute"]), float(r["price"])
    cands = cu.candidates(r["sym"], r["date"], minute, r["right"], spot)
    out = {}
    for mode in MODES:
        c, _ = cu.choose(cands, mode)
        if not c: continue
        csym, exp, k, dl, px, v30, iv = c
        sim.X.clear(); sim.X.update(cu.BOT)
        cost, steps, _ = sim.walk(r["sym"], r["date"], minute, r["right"], csym, exp, cu.CAL)
        if cost is None: out[mode] = {"status": "no fill"}; continue
        sold = sum(s[3] for s in steps if s[2] == "sell")
        out[mode] = dict(status="bought", contract=csym, expiry=exp, strike=k, delta=round(dl, 3), cost=round(cost, 2), iv=round(iv, 3) if iv else None,
                         steps=";".join(f"{s[0]} {s[1]} {s[2]} {s[3]:.2f} @{s[4]:.2f} {s[5]}" for s in steps[1:]),
                         ret=round(sim.result(cost, steps), 4) if sold >= 0.999 else None, open_share=round(1 - sold, 2), next_report=r.get("e_next"))
    return (r["date"], r["sym"], r["minute"]), out


def main():
    W = json.load(open(f"{cu.B}/list_{NAME}_{A}_{Z}.json"))
    todo = [r for r in W if r["status"].startswith("no contract: too_cheap") or r["status"].startswith("no contract: illiquid")]
    with mp.Pool(6) as pool: R = dict(pool.map(one, todo, chunksize=8))
    for mode in MODES:
        out = []
        for r in W:
            k = (r["date"], r["sym"], r["minute"])
            row = dict(r, list=f"{NAME}_{mode}")
            if k in R and mode in R[k]: row.update(R[k][mode])
            out.append(row)
        json.dump(out, open(f"{cu.B}/list_{NAME}_{mode}_{A}_{Z}.json", "w"), default=str, indent=1)
        print(mode, len(out), "signals,", sum(r["status"] == "bought" for r in out), "bought", flush=True)


if __name__ == "__main__":
    main()
