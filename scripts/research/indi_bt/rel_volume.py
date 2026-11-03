"""The volume against SPY's, on the champion 2.10 (the user, 2026-11-03: "can we also check the thesis in the main bot? if
today the main bot does not normelized the spy volume I think it might be a good candidate", after the Volume bot's
volume score; and "if we will add more trade we can catch more gaint that can cover these looses").
rel = the day volume ratio at the signal (c_rvol: the volume since the open over the median of the same span in the 20
sessions before) over SPY's own ratio at that minute (defence_signals.spy_ratio). Set before running:
  2.10      the champion (size_volume.py t3A-c5, thin_strike.py's champ walk): t >= 1.8 (or the D2 bonus) and rv >= 1.5x,
            0.5 / 1 / 1.5 size under 1.75 / 2.5x rv, the pyramid add within 5% of the account
  add15     the volume test passes on rv >= 1.5 OR rel >= 1.5 (every signal kept, more added; a moved signal is a new one)
  rel125 / rel150 / rel200   the volume test on rel >= 1.25 / 1.5 / 2.0 instead of rv
  size-rel  2.10's signals, the tiers on rel instead of rv
The gates use defence_signals.py BT_REL=1 rows (c12_15_* for the entry, base_* for the add); a gate's signal that is 2.10's
own is taken from 2.10's lists, a new one gets the same filters (fair list / Favorites, the news filter) and walk. The size
of a gate's trade stays 2.10's (on rv). Tune = even entry weeks, check = odd, in the same run; a pick per family (gate-add,
gate-replace, size) on tune by min(fair, Favorites) vs 2.10 at 2%. Also without 10 Oct 2025 (the market-wide day).

  BT_REL=1 BT_RULES=... BT_SPAN_END=2026-10-23 BT_SIG_SUFFIX=_relfair python3 defence_signals.py   (and _relfav, BT_SYMS)
  node --env-file=.env <dir>/run.mjs rel_volume.py      (from the app repo root)
-> data/local/x/bt/rel_volume_summary.json, rel_volume_added.csv
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
GATES = {"add15": "ra15", "rel125": "rr125", "rel150": "rr150", "rel200": "rr200"}
VERSIONS = ["2.10", *GATES, "size-rel"]
FAMILIES = {"gate-add": ("add15",), "gate-replace": ("rel125", "rel150", "rel200"), "size": ("size-rel",)}
# RV_GATES=add15 (the rerun after its missing books were bought, dbx_fetch.py open36): only 2.10 and those gates, to
# rel_volume_<gates>_summary.json / _added.csv
ONLY = os.environ.get("RV_GATES", "")
TAG = ""
if ONLY:
    GATES = {k: v for k, v in GATES.items() if k in ONLY.split(",")}
    VERSIONS = ["2.10", *GATES]
    FAMILIES = {f: tuple(v for v in vs if v in GATES) for f, vs in FAMILIES.items() if any(v in GATES for v in vs)}
    TAG = "_" + ONLY.replace(",", "_")
SIZES = TS.SIZES
t3A = lambda x: SV.tier(x, (1.75, 2.5), (0.5, 1.0, 1.5))
SKIPDAY = "2025-10-10"


def key(src, kind, t):
    return (src, kind, t["sym"], t["date"], t["right"], int(t["minute"]))


def generated(rule, src):
    out = []
    for f in sorted(glob.glob(f"{B}/s_sig_{rule}_rel{src}_20*.csv")):
        out += list(csv.DictReader(open(f)))
    return out


def keep_new(src, rows):
    """A new signal: the list's filters and the news filter, as 2.10's lists had them."""
    if src == "fair": rows = [t for t in rows if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST]
    else: rows = [t for t in rows if t["sym"] in FR.FAV and FR.A24 <= t["date"] <= FAV_END]
    if not rows: return []
    nf.features(rows)
    return [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]


def rel_of(t):
    """c_rvol over SPY's ratio at the signal minute."""
    i = CAL.index(t["date"])
    sr = ds.spy_ratio(t["date"], i, CAL)
    m = int(t["minute"])
    if not sr or not sr[m]: return None
    return float(t.get("c_rvol") or 0) / sr[m]


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    p = TS.pick(cu.candidates(t["sym"], t["date"], m0, t["right"], spot), floor, "champ", t["sym"], t["right"], spot)
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], d2=int(float(t.get("c_t") or 9) < 1.8),
               rvol=float(t.get("c_rvol") or 0), rel=t.get("rel"), x=None, contract=None, book=False)
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
        if v == "size-rel" and r["rel"] is not None: w = t3A(r["rel"])
        E.append((r["date"], m, w, x[full], x["over"], x["h"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or ad["x"] is None: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            aw = min(0.5 * w, max(0.0, 0.05 / size - w))
            if share > 0 and up is not None and up > 0 and aw > 0: E.append((ad["date"], ad["minute"], aw, ad["x"][halfk], ad["x"]["over"], ad["x"]["h"]))
            break
    return E


def table(R, sets, part, out, title, skip=None):
    tag = "" if skip is None else "|wo1010"
    for size in SIZES:
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000{'' if skip is None else ', without ' + skip}\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | vs 2.10 | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in VERSIONS:
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
                                     contract=r["contract"], book=int(r["book"]), rvol=round(r["rvol"], 2), rel="" if r["rel"] is None else round(r["rel"], 2), usd10k=round(u)))


def main():
    official = {"fair": {"main": fe.fair_signals("sg_c12_15"), "add": fe.fair_signals("s_t18r15")},
                "fav": {"main": FR.signals("25"), "add": FR.signals("24")}}
    inner = {"main": "c12_15", "add": "base"}
    rows, sets = {}, {"2.10": ([], []), "size-rel": ([], [])}
    for src in ("fair", "fav"):
        for kind in ("main", "add"):
            for t in official[src][kind]:
                k = key(src, kind, t); rows[k] = t
                sets["2.10"][0 if kind == "main" else 1].append(k)
                sets["size-rel"][0 if kind == "main" else 1].append(k)
    print("2.10 signals:", {s: {k: len(v) for k, v in d.items()} for s, d in official.items()}, flush=True)
    for v, suffix in GATES.items():
        sets[v] = ([], [])
    for src in ("fair", "fav"):
        for kind in ("main", "add"):
            off = {key(src, kind, t) for t in official[src][kind]}
            gen_base = {key(src, kind, t) for t in generated(inner[kind], src)}
            # the generator's 2.10 rows against 2.10's lists (inside the lists' filters): a check of the reproduction
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
    for t in rows.values():
        if "rel" not in t: t["rel"] = rel_of(t)
    jobs = [(k[0], k[1], t) for k, t in rows.items()]
    print(len(jobs), "signals to walk; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: walked = pool.map(one, jobs, chunksize=4)
    R = {key(r["src"], r["kind"], r): r for r in walked}
    out, changes = {}, []
    table(R, sets, "tune", out, "Tune weeks (even)")
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|2.10|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|2.10|fav|0.02"]["acct"])
    picks = {fam: max(vs, key=score) for fam, vs in FAMILIES.items()}
    out["picks"] = picks
    for fam, v in picks.items():
        print(f"\n🎯 {fam}: picked on tune (min of fair and Favorites vs 2.10, 2%): {v} ({score(v):.3f}); better on both: {score(v) > 1}")
    table(R, sets, "check", out, "Check weeks (odd), the same run")
    for part in ("tune", "check"):
        table(R, sets, part, out, f"{part.capitalize()} weeks", skip=SKIPDAY)
        changed(R, sets, part, out, changes)
    rels = [r["rel"] for k, r in R.items() if k[1] == "main" and r["rel"] is not None and k in set(sets["2.10"][0])]
    if rels:
        q = sorted(rels)
        print(f"\n2.10 main signals' rel: median {st.median(q):.2f}, p10 {q[len(q) // 10]:.2f}, p90 {q[9 * len(q) // 10]:.2f}; under 1.5: {sum(x < 1.5 for x in q)} of {len(q)}")
    json.dump(out, open(f"{B}/rel_volume{TAG}_summary.json", "w"), indent=1)
    if changes:
        with open(f"{B}/rel_volume{TAG}_added.csv", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(changes[0])); w.writeheader(); w.writerows(changes)


if __name__ == "__main__":
    main()
