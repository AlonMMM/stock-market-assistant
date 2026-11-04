"""2.10's size tiers on the volume against SPY's ("size-rel"), the follow-up (the user, 2026-11-03: "in parellal - lets
check the sizing thesis via spy relative on the main bot"). rel_volume.py found size-rel better than 2.10 on tune and
check, both lists, but worse on tune fair without the best 5, with its gain in the giants. Here, set before the run:
  2.10          the champion: 0.5 / 1 / 1.5 a unit under 1.75 / 2.5x rv (c_rvol)
  size-rel      the same tiers on rel = rv / SPY's ratio at the signal minute (rel_volume.rel_of)
  size-rel x0.8 / x1.2   the rel cuts 1.4 / 2.0 and 2.1 / 3.0 (neighbours)
  2.10 flat     2.10 with every trade scaled by f, f chosen on the tune half per list and size so its tune drop equals
                size-rel's tune drop (grid 0.70-1.60 by 0.01); the check reads that f
Tune = even entry weeks, check = odd, in the same run; 2% and 3%; also without 10 Oct 2025. Per tier (main legs at
$10K): count, median, giants, non-giant sum; and the trades size-rel sizes up / down against 2.10.
  node --env-file=.env <dir>/run.mjs size_rel.py      (from the app repo root)
-> data/local/x/bt/size_rel_summary.json
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rel_volume as RL
import size_volume as SV
import fav_real as FR
from split import half

SIZES = RL.SIZES
CUTS = {"2.10": None, "size-rel": (1.75, 2.5), "size-rel x0.8": (1.4, 2.0), "size-rel x1.2": (2.1, 3.0)}
LISTS = (("fair", ""), ("fav", FR.A24))


def weight(r, v, f=1.0):
    cuts = CUTS.get(v)
    if cuts is None or r["rel"] is None: return f * SV.tier(r["rvol"], (1.75, 2.5), (0.5, 1.0, 1.5))
    return SV.tier(r["rel"], cuts, (0.5, 1.0, 1.5))


def entries(R, sets, v, src, part, size, a="", skip=None, f=1.0):
    """rel_volume.entries with the version's weight (and the flat scale f on 2.10)."""
    full, halfk = SIZES[size]
    main_keys, add_keys = sets
    adds = collections.defaultdict(list)
    for k in add_keys:
        if k[0] == src: adds[(k[3], k[2], k[4])].append(R[k])
    E = []
    for k in main_keys:
        r = R[k]
        if k[0] != src or half(r["date"]) != part or r["date"] < a or r["x"] is None or r["date"] == skip: continue
        x, m = r["x"], r["minute"]
        w = weight(r, v, f)
        E.append((r["date"], m, w, x[full], x["over"], x["h"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or ad["x"] is None: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            aw = min(0.5 * w, max(0.0, 0.05 / size - w))
            if share > 0 and up is not None and up > 0 and aw > 0: E.append((ad["date"], ad["minute"], aw, ad["x"][halfk], ad["x"]["over"], ad["x"]["h"]))
            break
    return E


def flat_f(R, sets, src, a, size, target, skip=None):
    """The scale on 2.10 whose tune drop is closest to the target (ties: the larger f)."""
    best = None
    for i in range(70, 161):
        f = i / 100
        dd = SV.stats(entries(R, sets, "2.10", src, "tune", size, a, skip, f), size)["dd"]
        gap = abs(dd - target)
        if best is None or gap <= best[0]: best = (gap, f)
    return best[1]


def tiers(R, sets, part, src, a, skip):
    """Main legs at $10K by the tier each version gives them."""
    out = {}
    rows = [R[k] for k in sets[0] if k[0] == src and half(R[k]["date"]) == part and R[k]["date"] >= a and R[k]["x"] is not None and R[k]["date"] != skip]
    def grp(rs):
        usd = [1e4 * max(-1, r["x"]["r1"]) for r in rs]
        g = [u for r, u in zip(rs, usd) if r["x"]["r1"] >= 3]
        return dict(n=len(rs), median=round(st.median(usd)) if usd else 0, giants=len(g), nongiant=round(sum(usd) - sum(g)), sum=round(sum(usd)))
    for v in ("2.10", "size-rel"):
        for w in (0.5, 1.0, 1.5):
            out[f"{v}|{w}"] = grp([r for r in rows if weight(r, v) == w])
    out["up"] = grp([r for r in rows if weight(r, "size-rel") > weight(r, "2.10")])
    out["down"] = grp([r for r in rows if weight(r, "size-rel") < weight(r, "2.10")])
    out["same"] = grp([r for r in rows if weight(r, "size-rel") == weight(r, "2.10")])
    out["no_rel"] = sum(r["rel"] is None for r in rows)
    return out


def main():
    official = {"fair": {"main": RL.fe.fair_signals("sg_c12_15"), "add": RL.fe.fair_signals("s_t18r15")},
                "fav": {"main": FR.signals("25"), "add": FR.signals("24")}}
    rows, sets = {}, ([], [])
    for src in ("fair", "fav"):
        for kind in ("main", "add"):
            for t in official[src][kind]:
                k = RL.key(src, kind, t); rows[k] = t
                sets[0 if kind == "main" else 1].append(k)
    for t in rows.values():
        if "rel" not in t: t["rel"] = RL.rel_of(t)
    jobs = [(k[0], k[1], t) for k, t in rows.items()]
    print(len(jobs), "signals to walk", flush=True)
    with mp.Pool(8) as pool: walked = pool.map(RL.one, jobs, chunksize=4)
    R = {RL.key(r["src"], r["kind"], r): r for r in walked}
    out = {}
    for skip in (None, RL.SKIPDAY):
        tag = "" if skip is None else "|wo1010"
        flats = {}
        for size in SIZES:
            for src, a in LISTS:
                target = SV.stats(entries(R, sets, "size-rel", src, "tune", size, a, skip), size)["dd"]
                flats[(src, size)] = flat_f(R, sets, src, a, size, target, skip)
        out[f"flat{tag}"] = {f"{s}|{z}": f for (s, z), f in flats.items()}
        for part in ("tune", "check"):
            for size in SIZES:
                title = f"{part} weeks, {size:.0%} a trade{'' if skip is None else ', without ' + skip}"
                print(f"\n### {title}\n\n| Version | List | Trades | End / worst drop | vs 2.10 | vs 2.10 flat | Without the best 5 | Giants · non-giant sum | Median | By year |\n|---|---|---|---|---|---|---|---|---|---|")
                for src, a in LISTS:
                    f = flats[(src, size)]
                    vs = [("2.10", 1.0), (f"2.10 flat x{f:.2f}", f), ("size-rel", 1.0), ("size-rel x0.8", 1.0), ("size-rel x1.2", 1.0)]
                    res = {}
                    for name, sc in vs:
                        v = "2.10" if name.startswith("2.10") else name
                        res[name] = SV.stats(entries(R, sets, v, src, part, size, a, skip, sc), size)
                    base, flat = res["2.10"]["acct"], res[f"2.10 flat x{f:.2f}"]["acct"]
                    for name, s in res.items():
                        out[f"{part}|{name.split(' x')[0] if name.startswith('2.10 flat') else name}|{src}|{size}{tag}"] = dict(s, f=f if name.startswith("2.10 flat") else None)
                        yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                        print(f"| {name} | {src} | {s['trades']} | ${s['acct']:,} / {s['dd']:.1%} | {s['acct'] / base - 1:+.0%} | {s['acct'] / flat - 1:+.0%} | ${s['no5']:,} | {s['giants']} · {s['nongiant']:+,} | {s['median']:+,} | {yrs} |", flush=True)
        for part in ("tune", "check"):
            for src, a in LISTS:
                tz = tiers(R, sets, part, src, a, skip)
                out[f"tiers|{part}|{src}{tag}"] = tz
                print(f"\n#### Tiers, {part}, {src}{'' if skip is None else ', without ' + skip} (main legs at $10K: n · median · giants · non-giant sum)")
                for k2, g in tz.items():
                    if k2 == "no_rel": print(f"  no rel (sized on rv): {g}"); continue
                    print(f"  {k2:14s} {g['n']:4d} · {g['median']:+7,} · {g['giants']:3d} · {g['nongiant']:+10,} (sum {g['sum']:+,})")
    json.dump(out, open(f"{RL.B}/size_rel_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
