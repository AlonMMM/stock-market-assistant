"""The pyramid on the fallback trades (the user, 2026-10-25: "what if I do pyramid on the fallbacks as well?").

The D2 entries already get the pyramid's add on the real signal, fallback picks or not. This adds one for the other
fallback trades, the t >= 1.8 entries that bought a fallback contract (cheap: the nearest strike at $0.20+; liquid: the
next strike): they start at half size, and every 5 minutes for the first hour after the entry the bot looks at the
usual pick again; once the 0.15-delta contract passes the floor ($0.20, 200 contracts in 30 minutes) while the first
leg is still held, it adds half a size of that contract, walked with the same exits. Set before running:
  pyr-full     the pyramid, fallback trades at full size (the Favorites' best)
  pyr-half     the pyramid, fallback trades at half size (the fair list's best)
  fb-add       pyr-half + the add on the fallback trades (first leg still held)
  fb-add-up    pyr-half + the add on the fallback trades (first leg held and up)
On the fair list (Feb 2024 - Oct 2026) and the Favorites (12 and 6 months), from $100,000 at 1% and 2%.

  node --env-file=.env <dir>/run.mjs fb_pyramid.py      (from the repo root)
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import d2_scale as ds
import d2_bigadd as bg
import dd_more as dm
import fav_pyramid as fp
from store import day

eb.VERSIONS["fb_add"] = ("the fallback's add", "sg_c12_15", eb.VERSIONS[ds.BASE][2], None)


def fb_add(job):
    """-> key, (minute, leg) of the add on a t >= 1.8 fallback trade, or None; the first-leg 'up' at that minute too."""
    key, a = job
    m0 = int(a["minute"])
    for m in range(m0 + 5, min(m0 + 60, 374) + 1, 5):
        share, up = ds.held_at(a, m)
        if share <= 0: return key, None
        sb = [x for x in day(a["sym"], a["date"]) if x[0] <= m]
        if not sb: continue
        picked, _ = sim.pick(a["sym"], a["date"], m, a["right"], sb[-1][4])
        if not picked: continue
        t = dict(date=a["date"], sym=a["sym"], right=a["right"], minute=str(m), time="", price=sb[-1][4], contract=picked[0],
                 expiry=picked[1], iv="", status="ok", c_t="9")
        r = eb.one(("fb_add", t))
        if not r: return key, None
        steps = [(x, int(y), z, float(q), float(p), w) for x, y, z, q, p, w in (s.split(",") for s in r[1]["steps"].split(";"))]
        leg = dict(r[0], cost=float(r[1]["cost"]), steps=steps, c_t=9.0, added=0)
        return key, (m, up, leg)
    return key, None


def versions(first, adds, extra):
    pyr = bg.positions(first, adds, 1.0, 0.5)[0]
    out = {"pyr-full": fp.full_fb(pyr), "pyr-half": pyr}
    for name, need_up in (("fb-add", False), ("fb-add-up", True)):
        P = list(pyr)
        for k, x in extra.items():
            if x is None: continue
            m, up, leg = x
            if need_up and not (up is not None and up > 0): continue
            P.append((leg["date"], m, 0.5, leg))
        out[name] = sorted(P, key=lambda z: (z[0], z[1]))
    return out


def report(title, V, a, n_add):
    print(f"\n### {title}\n\n| Version | Positions | At 1% / worst drop | At 2% / worst drop | Without the best 5 at 1% |\n|---|---|---|---|---|")
    for name, P in V.items():
        P = [x for x in P if x[0] >= a]
        e1, d1, _ = dm.run(P, None, {}, 0.01); e2, d2, _ = dm.run(P, None, {}, 0.02)
        pnl = [x[2] * max(-1, dm.ret_at(x[3], x[2] * 0.01)) for x in P]
        top = set(sorted(range(len(P)), key=lambda i: -pnl[i])[:5])
        e5, _, _ = dm.run([x for i, x in enumerate(P) if i not in top], None, {}, 0.01)
        print(f"| {name} | {len(P)} | ${e1:,.0f} / {d1:.0%} | ${e2:,.0f} / {d2:.0%} | ${e5:,.0f} |", flush=True)
    print(f"fallback adds: {n_add}")


def main():
    lists = {"fair": (ds.load("sg_c12_15"), ds.load("s_t18r15")), "fav": (fp.load("fav86_25"), fp.load("fav86_24"))}
    for name, (c25, c24) in lists.items():
        with mp.Pool(6) as pool:
            R = [r for r in pool.map(ds.legs, [(ds.BASE, t) for t in c25] + [("leg2", t) for t in c24], chunksize=8) if r]
        first = {k: v for s, k, v in R if s == ds.BASE}
        adds = {k: v for s, k, v in R if s == "leg2"}
        jobs = [(k, a) for k, a in first.items() if a["added"] == 1 and a["c_t"] >= 1.8]
        with mp.Pool(6) as pool: extra = dict(pool.map(fb_add, jobs, chunksize=2))
        V = versions(first, adds, extra)
        n = sum(x is not None for x in extra.values())
        print(f"\n## {name}: {len(jobs)} t >= 1.8 fallback trades, {n} got the add")
        if name == "fair": report("Fair list, Feb 2024 - Oct 2026", V, "2024-01-01", n)
        else:
            report("Favorites, last 12 months", V, fp.A12, n)
            report("Favorites, last 6 months", V, fp.A6, n)


if __name__ == "__main__":
    main()
