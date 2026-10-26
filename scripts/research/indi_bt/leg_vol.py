"""The Alert leg (0DTE + 1DTE by 15:30, 0.35; the live rule) at other liquidity floors (the user, 2026-10-26: "how my
favorite will look like if the threshold for trades was 100 contracts?"). The leg must have traded min_vol30 contracts
in the 30 minutes before the side (the live minVolume, 200). Floors 50 / 100 / 150 / 200; no limits and the live
bot's (day loss 5%, 5 trades a day, 3 open), 1% and 2%, ±2% fill (±4% as a check). The fill model is the bar middle
± 2% at every floor: thinner contracts likely fill worse in practice.

  BT_UNIVERSE=fav BT_ALL=1 BT_FROM=2025-10-23 BT_TO=2026-10-22 node --env-file=.env <path>/run.mjs leg_vol.py
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from leg_export import entries
import leg_daycap as D

FLOORS = (50, 100, 150, 200)


def one(sig):
    out = {}
    for v in FLOORS:
        sim.C.update(min_vol30=v)
        r = D.one(sig)
        if r: out[v] = r
    return out


def main():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    lo, hi = os.environ.get("BT_FROM", "0000"), os.environ.get("BT_TO", "9999")
    ent = [e for e in entries() if lo <= e[0] <= hi]
    with mp.Pool(8) as pool: res = pool.map(one, ent, chunksize=4)
    rows = [dict(date=e[0], sym=e[1], minute=e[2], right="C", r=r) for e, r in zip(ent, res) if r]
    nf.features(rows)
    in_list = (lambda t: True) if os.environ.get("BT_ALL") else (lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]])
    keep = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and in_list(t)]
    cut2 = os.environ.get("BT_CUT2")
    spans = [("all", lambda t: True)] + ([(f"from {cut2}", lambda t: t["date"] >= cut2)] if cut2 else [])
    for sname, sf in spans:
        print(f"\n### {sname}\n\n| Floor | Limits | Size | Trades | Winners | ±2%: end, worst drop | worst day | without best 5 | ±4%: end, worst drop | added vs 200: P&L |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        for size in (1, 2):
            for lab, kw in (("none", {}), ("live", dict(loss=5, max_trades=5, max_open=3))):
                base = None
                for v in sorted(FLOORS, reverse=True):
                    T = [dict(date=t["date"], minute=t["minute"], sym=t["sym"], **t["r"][v]) for t in keep if v in t["r"] and sf(t)]
                    e1, d1, R, wd, rf = D.account(T, size, 2, **kw)
                    top = {(r["date"], r["sym"]) for r in sorted(R, key=lambda r: -r["pnl"])[:5]}
                    e5 = D.account([t for t in T if (t["date"], t["sym"]) not in top], size, 2, **kw)[0]
                    e4, d4, _, _, _ = D.account(T, size, 4, **kw)
                    keys = {(r["date"], r["sym"]) for r in R}
                    if base is None: base = keys
                    add = [r for r in R if (r["date"], r["sym"]) not in base]
                    print(f"| {v} | {lab} | {size}% | {len(R)} | {100 * sum(r['pnl'] > 0 for r in R) / max(1, len(R)):.0f}% | ${e1:,.0f}, {100 * d1:.1f}% | {100 * wd:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% | "
                          + ("—" if v == 200 else f"{sum(r['pnl'] for r in add):+,.0f} on {len(add)}") + " |")


if __name__ == "__main__":
    main()
