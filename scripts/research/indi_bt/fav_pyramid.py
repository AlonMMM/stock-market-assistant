"""The candidate stage of the pyramid (the user, 2026-10-25: "you can go now and run it against my favorites in the last 12
months"): the same versions as d2_scale.py / d2_bigadd.py on the user's 86 Favorites, 2025-10-23 to 2026-10-23 (and the
last 6 months, from 2026-04-23, as their own account). Signals: lists.py runs fav86_25 (2.5's entries) and fav86_24 (2.4's,
the real signal for the add). Versions: production 2.4, the candidate 2.5, 2.5 + cheap + the next strike for D2 (base),
+ both fallbacks at half, the pyramid (D2 1x + the add 0.5x held and up) + the fallback half, and D2 1x + add 1x.

  node --env-file=.env <dir>/run.mjs fav_pyramid.py      (from the repo root)
"""
import json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import d2_scale as ds
import d2_bigadd as bg
import dd_more as dm

B = "data/local/x/bt"
A12, A6, Z = "2025-10-23", "2026-04-23", "2026-10-23"


def load(name):
    out = []
    for r in json.load(open(f"{B}/list_{name}_{A12}_{Z}.json")):
        st = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}.get(r["status"])
        if st: out.append(dict(r, status=st, minute=str(r["minute"])))
    return out


def full_fb(P):
    """The pyramid with the fallback-added first legs back at full size (the adds stay at their size)."""
    return [(d, m, 1.0 if leg.get("added") == 1 and z == 0.5 and "leg2" not in leg["key"] else z, leg) for d, m, z, leg in P]


def main():
    c25, c24 = load("fav86_25"), load("fav86_24")
    jobs = [(ds.BASE, t) for t in c25] + [("leg2", t) for t in c24] + [("d2-bonus", t) for t in c25 if t["status"] == "ok"] + [("bot24", t) for t in c24 if t["status"] == "ok"]
    with mp.Pool(6) as pool: R = [r for r in pool.map(ds.legs, jobs, chunksize=8) if r]
    by = {}
    for s, k, v in R: by.setdefault(s, {})[k] = v
    first, adds = by[ds.BASE], by["leg2"]
    plain = lambda legs: sorted(((a["date"], int(a["minute"]), 1.0, a) for a in legs.values()), key=lambda x: (x[0], x[1]))
    versions = {
        "production 2.4": plain(by["bot24"]),
        "candidate 2.5": plain(by["d2-bonus"]),
        "2.5 + cheap + next strike for D2 (base)": plain(first),
        "+ both fallbacks at half": sorted(((a["date"], int(a["minute"]), 0.5 if a["added"] == 1 else 1.0, a) for a in first.values()), key=lambda x: (x[0], x[1])),
        "pyramid (D2 1x + add 0.5x), fallbacks at full size": full_fb(bg.positions(first, adds, 1.0, 0.5)[0]),
        "pyramid (D2 1x + add 0.5x) + fallbacks at half": bg.positions(first, adds, 1.0, 0.5)[0],
        "D2 1x + add 1x + fallbacks at half": bg.positions(first, adds, 1.0, 1.0)[0],
    }
    for title, a in (("Favorites, last 12 months (2025-10-23 to 2026-10-23)", A12), ("Favorites, last 6 months (from 2026-04-23)", A6)):
        print(f"\n### {title}\n\n| Version | Positions | Winners | At 1% / worst drop | At 2% / worst drop | Without the best 5 at 1% | Best 5 |\n|---|---|---|---|---|---|---|")
        for name, P in versions.items():
            P = [x for x in P if x[0] >= a]
            e1, d1, _ = dm.run(P, None, {}, 0.01); e2, d2, _ = dm.run(P, None, {}, 0.02)
            pnl = [x[2] * max(-1, dm.ret_at(x[3], x[2] * 0.01)) for x in P]
            top = sorted(range(len(P)), key=lambda i: -pnl[i])[:5]
            e5, _, _ = dm.run([x for i, x in enumerate(P) if i not in set(top)], None, {}, 0.01)
            best = ", ".join(f"{P[i][3]['sym']} {P[i][0][2:]} {pnl[i] * 1e4 / 1e3:+,.0f}K" for i in top)
            print(f"| {name} | {len(P)} | {sum(v > 0 for v in pnl)} | ${e1:,.0f} / {d1:.0%} | ${e2:,.0f} / {d2:.0%} | ${e5:,.0f} | {best} |", flush=True)


if __name__ == "__main__":
    main()
