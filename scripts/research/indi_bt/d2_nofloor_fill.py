"""nofloor's added trades: by the contract's volume in the last 30 minutes, and at a wider spread (2% / 5% / 10% a side)."""
import csv, glob, multiprocessing as mp, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import d2_liquid as d
import sim, news_filter as nf
from low_delta import HIS40, PRIOR
from score_sum import account, held
SPREADS = (0.02, 0.05, 0.10)

def one(t):
    out = {}
    for cheap in (False, True):
        c, why = d.pick_at(t, int(t["minute"]), float(t["price"]), cheap)
        if c or why != "illiquid": continue
        c, _ = d.pick_at(t, int(t["minute"]), float(t["price"]), cheap, floor=False)
        for sh in SPREADS:
            sim.SH = sh; sim.X.clear(); sim.X.update(d.CHAMP)
            cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], c[0], c[1], d.CAL)
            if cost is not None: out[(cheap, sh)] = (sim.result(cost, steps, 0.01), c[5], c[4], held(cost, steps))
    sim.SH = 0.02
    return (t["date"], t["sym"], t["minute"]), out

def base(t, cheap):
    """the version's own trade (plain or cheap) at the usual 2% spread."""
    sim.SH = 0.02; sim.X.clear(); sim.X.update(d.CHAMP)
    if t["status"] == "ok": p = (t["contract"], t["expiry"])
    else:
        c, _ = d.pick_at(t, int(t["minute"]), float(t["price"]), cheap) if cheap and t["status"] == "too_cheap" else (None, None)
        if not c: return None
        p = (c[0], c[1])
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], p[0], p[1], d.CAL)
    return None if cost is None else (sim.result(cost, steps, 0.01), held(cost, steps))

def both(t): return (t["date"], t["sym"], t["minute"]), (base(t, False), base(t, True))

if __name__ == "__main__":
    T = [t for f in glob.glob("data/local/x/bt/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
    T.sort(key=lambda t: (t["date"], int(t["minute"])))
    D2 = [t for t in T if t["status"] == "illiquid" and float(t["c_t"]) < 1.8]
    with mp.Pool(6) as pool:
        A = dict(pool.map(one, D2, chunksize=4)); Bs = dict(pool.map(both, T, chunksize=8))
    k = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    for cheap in (False, True):
        name = "cheap+nofloor" if cheap else "nofloor"
        print(f"\n### {name}, fair list")
        add = [(t, A[k(t)][(cheap, 0.02)]) for t in D2 if (cheap, 0.02) in A[k(t)]]
        print("| Contracts in the last 30 min | Trades | Winners | Sum at $10K | Per trade |\n|---|---|---|---|---|")
        for lo, hi in ((0, 25), (25, 50), (50, 100), (100, 200)):
            B = [pt(r[0]) for t, r in add if lo <= r[1] < hi]
            if B: print(f"| {lo}-{hi - 1} | {len(B)} | {sum(x > 0 for x in B)} | {sum(B) / 1e3:+,.0f}K | {sum(B) / len(B):+,.0f} |")
        print("\n| Spread a side on the added trades | Added sum at $10K | Without their best 5 | Account at 1% / worst drop | Without the best 5 |\n|---|---|---|---|---|")
        for sh in SPREADS:
            rows = []
            for t in T:
                b = Bs[k(t)][int(cheap)]
                if b is not None: rows.append(dict(date=t["date"], pnl=str(pt(b[0])), add=False, **b[1]))
                elif (cheap, sh) in A.get(k(t), {}):
                    a = A[k(t)][(cheap, sh)]
                    rows.append(dict(date=t["date"], pnl=str(pt(a[0])), add=True, **a[3]))
            ad = sorted((float(r["pnl"]) for r in rows if r["add"]), reverse=True)
            a1, d1 = account(rows)
            top = set(sorted(range(len(rows)), key=lambda i: -float(rows[i]["pnl"]))[:5])
            a5, _ = account([r for i, r in enumerate(rows) if i not in top])
            print(f"| {sh:.0%} | {sum(ad) / 1e3:+,.0f}K ({len(ad)}) | {sum(ad[5:]) / 1e3:+,.0f}K | ${a1:,.0f} / {100 * d1:.0f}% | ${a5:,.0f} |")
