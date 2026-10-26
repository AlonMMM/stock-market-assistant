"""Size by the contract's volume (the user, 2026-10-26: "what about 500 and half size for 100+? or double size on 500").

The 68 Favorites, 2025-10-23 to 2026-10-23, the lists.py runs at the 100-contract floor (fav68_24_v100 / fav68_25_v100);
each trade's contract volume in the 30 minutes before the entry is read again from the pick (sim.pick at the entry
minute, the floor at 100). Sizes by that volume, set before running:
  base 200        under 200 skipped, 1x (the bot today)
  flat 100        under 100 skipped, 1x
  half under 500  100-499 at half, 500+ at 1x
  half under 400  100-399 at half, 400+ at 1x (asked after the 500 run)
  double 500      under 200 skipped, 200-499 1x, 500+ 2x
  half / 1x / 2x  100-199 half, 200-499 1x, 500+ 2x
1% from $100,000 (a half trade's return taken at the 1% cap, a double at the 2% cap); the yardstick is the base at
another flat size with the same worst drop. Last 12 and 6 months.

  BT_CONTRACT='{"min_vol30":100}' node --env-file=.env <dir>/run.mjs liq_size.py      (from the repo root)
"""
import json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import sizing_sweep as sw

B = "data/local/x/bt"
A12, A6, Z = "2025-10-23", "2026-04-23", "2026-10-23"


def vol(r):
    p, _ = sim.pick(r["sym"], r["date"], int(r["minute"]), r["right"], float(r["price"]))
    return dict(r, v30=p[5] if p and p[0] == r["contract"] else None)


def size_of(rule, v):
    if v is None: return 0
    if rule == "base 200": return 1.0 if v >= 200 else 0
    if rule == "flat 100": return 1.0
    if rule == "half under 500": return 1.0 if v >= 500 else 0.5
    if rule == "half under 400": return 1.0 if v >= 400 else 0.5  # the user, 2026-10-26: "full 400 and above and 0.5 all the rest"
    if rule == "double 500":
        if v < 200: return 0
        return 2.0 if v >= 500 else 1.0
    if v < 200: return 0.5
    return 2.0 if v >= 500 else 1.0


def account(T, rule, a, flat=1.0):
    eq, peak, dd, cur, start = 1e5, 1e5, 0.0, None, 1e5
    for r in T:
        if r["date"] < a: continue
        if r["date"] != cur: cur, start = r["date"], eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        s = size_of(rule, r["v30"]) * flat
        if not s: continue
        ret = r["ret_2pct"] if s > 1 else r["ret"]
        eq += 0.01 * s * start * max(-1, ret)
    return eq, max(dd, 1 - eq / max(peak, eq))


def main():
    for bot, name in (("2.4", "fav68_24_v100"), ("2.5", "fav68_25_v100")):
        R = [r for r in json.load(open(f"{B}/list_{name}_{A12}_{Z}.json")) if r["status"] == "bought" and r["ret"] is not None]
        with mp.Pool(6) as pool: T = sorted(pool.map(vol, R, chunksize=8), key=lambda r: (r["date"], r["minute"]))
        v = [r["v30"] for r in T if r["v30"] is not None]
        print(f"\n## {bot}: {len(T)} trades at the 100 floor; 100-199: {sum(x < 200 for x in v)}, 200-499: {sum(200 <= x < 500 for x in v)}, 500+: {sum(x >= 500 for x in v)}, volume not read: {len(T) - len(v)}")
        for grp, lo, hi in (("100-199", 100, 200), ("200-499", 200, 500), ("500+", 500, 10 ** 9)):
            g = [1e4 * max(-1, r["ret"]) for r in T if r["v30"] is not None and lo <= r["v30"] < hi]
            gs = sorted(g, reverse=True)
            print(f"  {grp}: {len(g)} trades, {sum(x > 0 for x in g)} won, {sum(g) / 1e3:+,.0f}K at $10K, {sum(gs[5:]) / 1e3:+,.0f}K without the best 5")
        for title, a in (("last 12 months", A12), ("last 6 months", A6)):
            flat = [(account(T, "base 200", a, f)[1], account(T, "base 200", a, f)[0]) for f in (0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)]
            print(f"\n{bot}, {title}\n| Sizing | Account at 1% | Worst drop | Base at the size with the same drop | Edge |\n|---|---|---|---|---|")
            for rule in ("base 200", "flat 100", "half under 400", "half under 500"):
                e, d = account(T, rule, a)
                f = sw.edge(flat, d, e)
                print(f"| {rule} | ${e:,.0f} | {d:.0%} | {'$%s' % format(round(f), ',') if f else 'beyond'} | {f'{e / f - 1:+.0%}' if f else ''} |", flush=True)


if __name__ == "__main__":
    main()
