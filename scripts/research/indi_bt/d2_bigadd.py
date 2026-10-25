"""D2 small, the real signal big (the user, 2026-10-25: "if D2 enters 50% then we hit the signal we can enter even bigger -
1.5-2X (when 1-1.5X is what we added)").

On 2.5 + cheap + the next strike for D2 with both fallbacks' trades at half size. A D2 entry (t < 1.8) buys half the
usual size; when the same stock reaches the real signal (t >= 1.8, same side) with that half still held and up, the bot
adds a fresh 0.15-delta contract of 1x or 1.5x the usual size (1.5x / 2x in all). The t >= 1.8 entries keep their size.
Set before running, against the pyramid (D2 1x + the add 0.5x, $1,667,924 / 12%):
  d2 0.5 + add 0.5    the scale-in of d2_scale.py, with the fallback half
  d2 0.5 + add 1.0    1.5x in all on a confirmed D2 move (the thesis)
  d2 0.5 + add 1.5    2x in all (the thesis)
  d2 1.0 + add 1.0    the pyramid with a bigger add (a neighbour)
Each leg's overnight cap at its own size. Fair list, Feb 2024 - Oct 2026, from $100,000 at 1% and 2%.

  node --env-file=.env <dir>/run.mjs d2_bigadd.py      (from the repo root)
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import d2_scale as ds
import dd_more as dm
import sizing_sweep as sw

VARIANTS = {"pyramid (d2 1.0 + add 0.5)": (1.0, 0.5), "d2 0.5 + add 0.5": (0.5, 0.5), "d2 0.5 + add 1.0": (0.5, 1.0),
            "d2 0.5 + add 1.5": (0.5, 1.5), "d2 1.0 + add 1.0": (1.0, 1.0)}


def positions(first, adds, d2_size, add_size):
    out, n = [], 0
    for k, a in first.items():
        d2 = a["c_t"] < 1.8
        size = 0.5 if a["added"] == 1 else 1.0
        if d2: size = d2_size if a["added"] != 1 else min(d2_size, 0.5)
        out.append((a["date"], int(a["minute"]), size, a))
        if d2:
            b = adds.get(k)
            if b and int(b["minute"]) > int(a["minute"]):
                share, up = ds.held_at(a, int(b["minute"]))
                if share > 0 and up is not None and up > 0: out.append((b["date"], int(b["minute"]), add_size, b)); n += 1
    return sorted(out, key=lambda x: (x[0], x[1])), n


def main():
    cand, reg_t = ds.load("sg_c12_15"), ds.load("s_t18r15")
    with mp.Pool(6) as pool:
        R = [r for r in pool.map(ds.legs, [(ds.BASE, t) for t in cand] + [("leg2", t) for t in reg_t], chunksize=8) if r]
    first = {k: v for s, k, v in R if s == ds.BASE}
    adds = {k: v for s, k, v in R if s == "leg2"}
    for pct in (0.01, 0.02):
        base, _ = positions(first, adds, 1.0, 0.5)
        flat = [(dm.run(base, None, {}, pct, f)[1], dm.run(base, None, {}, pct, f)[0]) for f in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4)]
        print(f"\n### At {pct:.0%} a trade\n\n| Version | Adds | 2024 / 2025 / 2026 at $10K | Account | Worst drop | Flat pyramid with the same drop | Edge | Without the best 5 |\n|---|---|---|---|---|---|---|---|")
        for name, (d2s, adds_s) in VARIANTS.items():
            P, n = positions(first, adds, d2s, adds_s)
            e, d, _ = dm.run(P, None, {}, pct)
            pnl = [(x[0], x[2] * max(-1, dm.ret_at(x[3], x[2] * pct))) for x in P]
            yrs = " / ".join(f"{sum(v for dd_, v in pnl if dd_[:4] == y) * 1e4 / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
            top = set(sorted(range(len(P)), key=lambda i: -pnl[i][1])[:5])
            e5, _, _ = dm.run([x for i, x in enumerate(P) if i not in top], None, {}, pct)
            f = sw.edge(flat, d, e)
            print(f"| {name} | {n} | {yrs} | ${e:,.0f} | {d:.0%} | {'$%s' % format(round(f), ',') if f else 'beyond flat'} | {f'{e / f - 1:+.0%}' if f else ''} | ${e5:,.0f} |", flush=True)


if __name__ == "__main__":
    main()
