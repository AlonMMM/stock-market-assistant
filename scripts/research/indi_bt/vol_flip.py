"""The volume after a flip, on the champion 2.10 (the user, 2026-11-05: "when T is switching from call to put, the volume
stay - correct?"; "it can only remove trader right? not add"; "try all of them"). 2.10's volume test is the day volume
ratio (rv: the volume since the open over the median of the same span in the 20 sessions before), the same number for a
call and a put, so a morning's selloff volume also passes, and sizes (the 0.5 / 1 / 1.5 tiers), a later call. The rules
come from defence_signals.py BT_FLIP=1 (c12_15_* for the entry, base_* for the add); levels set before running:
  2.10                  the champion (size_volume.py t3A-c5, thin_strike.py's champ walk)
  recent: r30-125 / r30-150 / r30-200   the last 30 minutes' volume over the usual of that window >= 1.25 / 1.5 / 2.0x,
                        instead of rv (a quiet morning with a fresh burst now passes: it can add trades)
  dir: dir50 / dir55 / dir60            rv >= 1.5x and >= 50 / 55 / 60% of the volume since the open on minutes the
                        stock moved the bet's way (stock minus beta x SPY)
  flip: flip10 / flip15 / flip18        when the opposite side's t reached 1.0 / 1.5 / 1.8 earlier today, the ratio
                        counts from the last minute this side's t was <= 0, instead of from the open
  size: size-r30 / size-flip            2.10's signals, the tiers on the 30-minute ratio / on the after-flip ratio
                        (when the opposite t reached 1.0, else rv)
A gate's trade keeps 2.10's size (on rv). Also the diagnostic: 2.10's main legs by the opposite side's best t earlier
that day (c_opp). Tune = even entry weeks, check = odd, in the same run; a pick per family on tune by min(fair,
Favorites) vs 2.10 at 2%; only the picks on check. Every change is a full re-walk (a removed or delayed signal frees
a slot, a later one can fire).

  BT_FLIP=1 BT_RULES=... BT_SPAN_END=2026-10-23 BT_SIG_SUFFIX=_flipfair python3 defence_signals.py   (and _flipfav, BT_SYMS)
  node --env-file=.env <dir>/run.mjs vol_flip.py      (from the app repo root)
-> data/local/x/bt/vol_flip_summary.json, vol_flip_changed.csv
"""
import collections, csv, glob, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import size_volume as SV   # sets 2.9's exits (BT_X) before sim is imported
import thin_strike as TS
import cheap_up as cu
import defence_signals as ds
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import news_filter as nf
import real_bench as RB
from low_delta import HIS40, PRIOR
from split import half
from store import calendar

B = "data/local/x/bt"
CAL = calendar()
FAV_END = FR.Z
GATES = {"r30-125": "r30125", "r30-150": "r30150", "r30-200": "r30200", "dir50": "dir50", "dir55": "dir55",
         "dir60": "dir60", "flip10": "flip10", "flip15": "flip15", "flip18": "flip18"}
SIZEV = ("size-r30", "size-flip")
VERSIONS = ["2.10", *GATES, *SIZEV]
FAMILIES = {"recent": ("r30-125", "r30-150", "r30-200"), "dir": ("dir50", "dir55", "dir60"),
            "flip": ("flip10", "flip15", "flip18"), "size": SIZEV}
TAG = ""
SIZES = TS.SIZES
t3A = lambda x: SV.tier(x, (1.75, 2.5), (0.5, 1.0, 1.5))
FLIP_SIZE_OPP = 1.0


def key(src, kind, t):
    return (src, kind, t["sym"], t["date"], t["right"], int(t["minute"]))


def generated(rule, src):
    out = []
    for f in sorted(glob.glob(f"{B}/s_sig_{rule}_flip{src}_20*.csv")):
        out += list(csv.DictReader(open(f)))
    return out


def keep_new(src, rows):
    """A new signal: the list's filters and the news filter, as 2.10's lists had them."""
    if src == "fair": rows = [t for t in rows if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST]
    else: rows = [t for t in rows if t["sym"] in FR.FAV and FR.A24 <= t["date"] <= FAV_END]
    if not rows: return []
    nf.features(rows)
    return [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    p = TS.pick(cu.candidates(t["sym"], t["date"], m0, t["right"], spot), floor, "champ", t["sym"], t["right"], spot)
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], d2=int(float(t.get("c_t") or 9) < 1.8),
               rvol=float(t.get("c_rvol") or 0), x=None, contract=None, book=False,
               **{k: (float(t[k]) if t.get(k) not in (None, "") else None) for k in ("c_opp", "c_rv30", "c_share", "c_rvflip")})
    if not p: return out
    c = p[0]
    out["contract"] = c[0]
    out["book"] = RB.quote(c[0], t["date"], max(m0 - 1, 0)) is not None
    out["x"] = TS.walk_c(t, m0, c)
    return out


def entries(R, sets, v, src, part, size, a="", skip=None):
    full, halfk = SIZES[size]
    main_keys, add_keys = sets[v]
    adds = collections.defaultdict(list)
    for k in add_keys:
        if k[0] == src: adds[(k[3], k[2], k[4])].append(R[k])
    E = []
    for k in main_keys:
        r = R[k]
        if k[0] != src or half(r["date"]) != part or r["date"] < a or r["x"] is None or r["date"] == skip: continue
        x, m = r["x"], r["minute"]
        w = t3A(r["rvol"])
        if v == "size-r30" and r["c_rv30"] is not None: w = t3A(r["c_rv30"])
        if v == "size-flip" and r["c_opp"] is not None and r["c_opp"] >= FLIP_SIZE_OPP: w = t3A(r["c_rvflip"])
        E.append((r["date"], m, w, x[full], x["over"], x["h"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or ad["x"] is None: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            aw = min(0.5 * w, max(0.0, 0.05 / size - w))
            if share > 0 and up is not None and up > 0 and aw > 0: E.append((ad["date"], ad["minute"], aw, ad["x"][halfk], ad["x"]["over"], ad["x"]["h"]))
            break
    return E


def table(R, sets, part, out, title, skip=None, versions=None):
    tag = "" if skip is None else "|wo1010"
    for size in SIZES:
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000{'' if skip is None else ', without ' + skip}\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | vs 2.10 | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in versions or VERSIONS:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(entries(R, sets, v, src, part, size, a, skip), size)
                out[f"{part}|{v}|{src}|{size}{tag}"] = s
                base = out[f"{part}|2.10|{src}|{size}{tag}"]["acct"]
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | {s['acct'] / base - 1:+.0%} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)


def changed(R, sets, part, out, rows_out):
    print(f"\n#### {part} weeks: main legs each gate added or removed vs 2.10 (at $10K, 1% basis)\n")
    print("| Version | List | Added | Median | +300% | Sum | Bar-priced (no real book at the buy) | Removed | Median | +300% | Sum |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    champ = {k for k in sets["2.10"][0]}
    for v in GATES:
        mine = set(sets[v][0])
        for src, a in (("fair", ""), ("fav", FR.A24)):
            def grp(keys):
                rs = [R[k] for k in keys if k[0] == src and half(R[k]["date"]) == part and R[k]["date"] >= a and R[k]["x"] is not None]
                usd = [1e4 * max(-1, r["x"]["r1"]) for r in rs]
                return rs, usd
            ar, au = grp(mine - champ)
            rr, ru = grp(champ - mine)
            s = dict(added=len(ar), a_med=round(st.median(au)) if au else 0, a_giants=sum(r["x"]["r1"] >= 3 for r in ar), a_sum=round(sum(au)),
                     a_bar=sum(not r["book"] for r in ar), removed=len(rr), r_med=round(st.median(ru)) if ru else 0,
                     r_giants=sum(r["x"]["r1"] >= 3 for r in rr), r_sum=round(sum(ru)))
            out[f"{part}|{v}|{src}|changed"] = s
            print(f"| {v} | {src} | {s['added']} | {s['a_med']:+,} | {s['a_giants']} | {s['a_sum']:+,} | {s['a_bar']} | {s['removed']} | {s['r_med']:+,} | {s['r_giants']} | {s['r_sum']:+,} |", flush=True)
            for r, u in zip(ar, au):
                rows_out.append(dict(part=part, version=v, list=src, change="added", date=r["date"], minute=r["minute"], sym=r["sym"], right=r["right"],
                                     contract=r["contract"], book=int(r["book"]), rvol=round(r["rvol"], 2), opp=r["c_opp"], usd10k=round(u)))
            for r, u in zip(rr, ru):
                rows_out.append(dict(part=part, version=v, list=src, change="removed", date=r["date"], minute=r["minute"], sym=r["sym"], right=r["right"],
                                     contract=r["contract"], book=int(r["book"]), rvol=round(r["rvol"], 2), opp=r["c_opp"], usd10k=round(u)))


def diagnostic(R, sets, out):
    """2.10's main legs by the opposite side's best t earlier that day (c_opp, from the generator's own 2.10 rows)."""
    groups = (("never the other side (< 0)", -1e9, 0.0), ("0 to 1.0", 0.0, 1.0), ("1.0 to 1.8", 1.0, 1.8), ("1.8 or more (a full opposite signal)", 1.8, 1e9))
    print("\n#### The diagnostic: 2.10's main legs by how far the other side's t went earlier that day (at $10K, 1% basis)\n")
    print("| Part | List | Group | Trades | Winners | Median | +300% | Non-giant sum | Sum |")
    print("|---|---|---|---|---|---|---|---|---|")
    for part in ("tune", "check"):
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rs = [R[k] for k in sets["2.10"][0] if k[0] == src and half(R[k]["date"]) == part and R[k]["date"] >= a and R[k]["x"] is not None]
            for name, lo, hi in groups + (("unknown (not reproduced)", None, None),):
                if lo is None: g = [r for r in rs if r["c_opp"] is None]
                else: g = [r for r in rs if r["c_opp"] is not None and lo <= r["c_opp"] < hi]
                if not g: continue
                usd = [1e4 * max(-1, r["x"]["r1"]) for r in g]
                giant = [u for u, r in zip(usd, g) if r["x"]["r1"] >= 3]
                s = dict(n=len(g), win=sum(u > 0 for u in usd) / len(g), med=round(st.median(usd)), giants=len(giant),
                         nongiant=round(sum(usd) - sum(giant)), sum=round(sum(usd)))
                out[f"diag|{part}|{src}|{name}"] = s
                print(f"| {part} | {src} | {name} | {s['n']} | {s['win']:.0%} | {s['med']:+,} | {s['giants']} | {s['nongiant']:+,} | {s['sum']:+,} |", flush=True)


def main():
    official = {"fair": {"main": fe.fair_signals("sg_c12_15"), "add": fe.fair_signals("s_t18r15")},
                "fav": {"main": FR.signals("25"), "add": FR.signals("24")}}
    inner = {"main": "c12_15", "add": "base"}
    rows, sets = {}, {"2.10": ([], [])}
    for v in SIZEV: sets[v] = ([], [])
    for src in ("fair", "fav"):
        for kind in ("main", "add"):
            for t in official[src][kind]:
                k = key(src, kind, t); rows[k] = t
                for v in ("2.10", *SIZEV): sets[v][0 if kind == "main" else 1].append(k)
    print("2.10 signals:", {s: {k: len(v) for k, v in d.items()} for s, d in official.items()}, flush=True)
    for v in GATES: sets[v] = ([], [])
    for src in ("fair", "fav"):
        for kind in ("main", "add"):
            off = {key(src, kind, t) for t in official[src][kind]}
            gen_rows = generated(inner[kind], src)
            gen_base = {key(src, kind, t) for t in gen_rows}
            # the generator's flip columns onto 2.10's own signals (the diagnostic and the size versions)
            cols = {key(src, kind, t): t for t in gen_rows}
            for k in off:
                g = cols.get(k)
                for c in ("c_opp", "c_rv30", "c_share", "c_rvflip"): rows[k][c] = g[c] if g else ""
            base_in = {key(src, kind, t) for t in keep_new(src, generated(inner[kind], src))}
            print(f"{src} {kind}: 2.10 lists {len(off)}, generated base after filters {len(base_in)}, both {len(off & base_in)}", flush=True)
            for v, suffix in GATES.items():
                gen = generated(f"{inner[kind]}_{suffix}", src)
                same = [t for t in gen if key(src, kind, t) in gen_base]
                new = keep_new(src, [t for t in gen if key(src, kind, t) not in gen_base])
                keys = [key(src, kind, t) for t in same if key(src, kind, t) in off]
                for t in new:
                    k = key(src, kind, t); keys.append(k); rows.setdefault(k, t)
                sets[v][0 if kind == "main" else 1].extend(keys)
                print(f"   {v}: {len(gen)} rows, as 2.10 {len(same)} (in its lists {len(keys) - len(new)}), new {len(new)}", flush=True)
    jobs = [(k[0], k[1], t) for k, t in rows.items()]
    print(len(jobs), "signals to walk; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: walked = pool.map(one, jobs, chunksize=4)
    R = {key(r["src"], r["kind"], r): r for r in walked}
    out, changes = {}, []
    diagnostic(R, sets, out)
    table(R, sets, "tune", out, "Tune weeks (even)")
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|2.10|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|2.10|fav|0.02"]["acct"])
    picks = {fam: max(vs, key=score) for fam, vs in FAMILIES.items()}
    out["picks"] = picks
    for fam, v in picks.items():
        print(f"\n🎯 {fam}: picked on tune (min of fair and Favorites vs 2.10, 2%): {v} ({score(v):.3f}); better on both: {score(v) > 1}")
    table(R, sets, "check", out, "Check weeks (odd), the same run", versions=["2.10", *picks.values()])
    changed(R, sets, "tune", out, changes)
    keep = GATES
    GATES_ALL = dict(GATES)
    globals()["GATES"] = {v: GATES_ALL[v] for v in picks.values() if v in GATES_ALL}
    changed(R, sets, "check", out, changes)
    globals()["GATES"] = keep
    json.dump(out, open(f"{B}/vol_flip_summary.json", "w"), indent=1)
    if changes:
        with open(f"{B}/vol_flip_changed.csv", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(changes[0])); w.writeheader(); w.writerows(changes)


if __name__ == "__main__":
    main()
