"""The huge-winner stops on the Bot vs Indi dashboard (the user, 2026-10-27: "I want to see the trades like we have trades
on this doc for the 2 lists - to understand what trades with cutted"), exit_tests.py EXIT_RUN=big's two +1000% versions
on the champion's entries and picks (2.5 + IBIT down to $0.10 + the pyramid, no cheap fallback):
  big-opt   once the option was up +1000% (any day held), all out when it falls 30% from its best
  big-stk   once the option was up +1000%, all out when the stock gives back 1.0 x S30 from its best since then
Lists: the fair list ('' prefix, against `champ`) and the Favorites 24 months (fav24:, against fav24:champ), in
export_champ.py's shapes: trades, paths, bars and the fills at +-5%, +-10% and on the real book. Each version's pyramid
reads its own first leg (held and up on the real mid).

  node --env-file=.env <dir>/run.mjs export_big.py <out dir>      (from the app repo root)
-> <out>/big_trades.csv, big_paths.csv, big_bars.csv, big_fills_{f5,f10,real}.csv
"""
import collections, csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import cheap_up as cu
import export_bench as eb
import export_champ as ec
import export_fav_long as efl
import fav_bench as fb
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from d2_failed_break import CHAMP
from store import day

CAL = eb.CAL
V = {"big-opt": ("Champion + option stop from +1000%", {**CHAMP, "guard": {"arm": 10.0, "trail": 0.3}}),
     "big-stk": ("Champion + stock stop from +1000%", {**CHAMP, "big_trail": {"arm": 10.0, "k": 1.0}})}
for slug, (name, _) in V.items(): ec.V[slug] = (name,)


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    cands = cu.candidates(t["sym"], t["date"], int(t["minute"]), t["right"], float(t["price"]))
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return src, kind, t, {}
    c = (p[0][0], p[0][1])
    res = {}
    for slug, (_, exits) in V.items():
        w = efl.walk(t, c, exits)
        if w: res[slug] = (c, w)
    return src, kind, t, res


def main():
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    S = fb.signals()
    fair_add = [t for f in glob.glob(f"{eb.B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    eb.nf.features(fair_add)
    fair_add = [t for t in fair_add if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in eb.HIS40 and t["sym"] in eb.PRIOR[t["date"][:4]]]
    jobs = [("fair", "main", t) for t in S[("fair", "sg_c12_15")]] + [("fair", "add", t) for t in fair_add]
    jobs += [("fav", "main", t) for t in FR.signals("25") if t["date"] >= efl.A24] + [("fav", "add", t) for t in FR.signals("24") if t["date"] >= efl.A24]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = pool.map(one, jobs, chunksize=4)
    adds = collections.defaultdict(list)
    for src, kind, t, res in R:
        if kind == "add": adds[(src, t["date"], t["sym"], t["right"])].append((t, res))
    trades, paths, fills = [], [], collections.defaultdict(list)
    for src, kind, t, res in R:
        if kind != "main": continue
        pre = "" if src == "fair" else "fav24:"
        for slug in V:
            if slug not in res: continue
            c, w = res[slug]
            base = f"{slug}-{t['date']}-{t['sym']}-{t['right']}-{t['minute']}"
            legs = [(t, c, w, False, base)]
            if float(t.get("c_t") or 9) < 1.8:
                for a, ares in sorted(adds.get((src, t["date"], t["sym"], t["right"]), []), key=lambda x: int(x[0]["minute"])):
                    if int(a["minute"]) <= int(t["minute"]) or slug not in ares: continue
                    share, up = w["held"].get(int(a["minute"]), (0, None))
                    if share > 0 and up is not None and up > 0:
                        ac, aw = ares[slug]
                        legs.append((a, ac, aw, True, f"{base}+add"))
                    break
            for lt, lc, lw, half, key in legs:
                row, path, fl = ec.rows_of(slug, lt, lc, lw, half, key)
                trades.append(dict(row, version=pre + slug, key=pre + key))
                paths.append(dict(path, key=pre + key))
                for m in ("f5", "f10", "real"): fills[m].append(dict(fl[m], key=pre + key))
    keys = set()
    for r in trades:
        i = CAL.index(r["date"])
        for s in (r["sym"], "SPY"): keys.add((s, r["date"], CAL[i - 1]))
    bars = [dict(key=f"{s}|{d}", prev_date=pd, closes=" ".join(eb.closes5(day(s, pd)) + eb.closes5(day(s, d)))) for s, d, pd in sorted(keys)]
    for fname, data in [("big_trades.csv", trades), ("big_paths.csv", paths), ("big_bars.csv", bars)] + [(f"big_fills_{m}.csv", v) for m, v in fills.items()]:
        with open(f"{out}/{fname}", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys())); w.writeheader(); w.writerows(data)
        print(fname, len(data), "rows", os.path.getsize(f"{out}/{fname}") // 1024, "KB", flush=True)
    for slug in V:
        for pre in ("", "fav24:"): print(pre + slug, sum(r["version"] == pre + slug for r in trades), "rows")


if __name__ == "__main__":
    main()
