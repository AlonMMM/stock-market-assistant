"""The champion with early entry on the Bot vs Indi dashboard (the user, 2026-10-27: "so we have new champ. can you show
all in the benchmark?"), in export_champ.py's shapes, fair list and Favorites (fav12: / fav6:, fav_bench.py's signals):
  champ-1s     the champion, each buy on the option's 1-second book at the decision second (the usual price, the runaway
               rule with a 60-second look-ahead): the yardstick in the same price model
  champ-early  THE CHAMPION (2026-10-27): the same, buying at the first second inside the signal minute the rule holds
               (sec_timing.py "early-r60")
Both are real quotes only: their +-2% / +-5% / +-10% / real / fair columns all carry the same 1-second fills. A leg with no
1-second book keeps its minute price.

  node --env-file=.env <dir>/run.mjs export_early.py <out dir>      (from the app repo root)
-> <out>/early_trades.csv, early_paths.csv, early_fills_{f5,f10,real,fair}.csv
"""
import collections, csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import export_bench as eb
import export_champ as ec
import fav_bench as fb
import sec_timing as ST

V = {"champ-1s": "now-1s-r60", "champ-early": "early-r60"}
ec.V.update({"champ-1s": ("Champion, 1-second fills",), "champ-early": ("Champion + early entry",)})   # rows_of reads the name


# BT_BASIS: "real" (default, the 2.9 release audit 2026-11-01): each variant is walked again with its own 1-second fill as
# the walk's cost, so its exits (stops, the overnight hold, be_lock) read gains off what was really paid; "model" = the
# old way (one walk on the minute model's buy, the 1-second price swapped in afterwards).
BASIS = os.environ.get("BT_BASIS", "real")


def rewalk(r, t, slug):
    """-> (paid, real steps, held) of the leg walked with variant `slug`'s 1-second fill as its cost, or None."""
    import sim, opt_spread as OS, real_bench as RB
    got = r["buys"].get(V[slug])
    if not got: return None
    s, p = got
    m0 = int(t["minute"]); c = r["contract"]; exp = sim_expiry(c)
    sim.X.clear(); sim.X.update(ST.FF.CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], c, exp, ST.FF.CAL, paid=p)
    if cost is None: return None
    _, real = OS.price(steps, c, cost, "bid")
    first_sale = min((x[1] for x in real if x[2] == "sell" and x[0] == t["date"]), default=999)
    m = s // 60
    if m >= first_sale: return None
    real = [(t["date"], m, "buy", 1.0, p, "entry")] + real[1:]
    sells = [x for x in real if x[2] == "sell" and x[0] == t["date"]]
    held = {}
    for mm in range(m0, 390):
        k = RB.quote(c, t["date"], mm)
        held[mm] = (1 - sum(x[3] for x in sells if x[1] <= mm), None if not k else (k[0] + k[1]) / 2 / p - 1)
    return p, real, held


def legs_of(r):
    """{slug: (paid, steps)} for one leg."""
    out = {}
    first_sale = min((x[1] for x in r["steps"] if x[2] == "sell" and x[0] == r["date"]), default=999)
    for slug, v in V.items():
        if slug in r.get("walked", {}):
            p, steps, _ = r["walked"][slug]; out[slug] = (p, steps); continue
        got = r["buys"].get(v)
        paid, steps = r["paid"], r["steps"]
        if got:
            s, p = got
            m = s // 60
            if m < first_sale: paid, steps = p, [(r["date"], m, "buy", 1.0, p, "entry")] + r["steps"][1:]
        out[slug] = (paid, steps)
    return out


def one(job):
    r = ST.one(job[:3])
    if not r: return None
    if BASIS == "real":
        r["walked"] = {slug: w for slug in V if (w := rewalk(r, job[2], slug))}
    return job[0], job[1], job[2], r


def main():
    out = sys.argv[1]
    S = fb.signals()
    fair_add = [t for f in glob.glob(f"{eb.B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    eb.nf.features(fair_add)
    fair_add = [t for t in fair_add if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in eb.HIS40 and t["sym"] in eb.PRIOR[t["date"][:4]]]
    jobs = [("fair", "main", t) for t in S[("fair", "sg_c12_15")]] + [("fair", "add", t) for t in fair_add]
    jobs += [("fav", "main", t) for t in S[("fav", "sg_c12_15")]] + [("fav", "add", t) for t in S[("fav", "s_t18r15")]]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [x for x in pool.map(one, jobs, chunksize=4) if x]
    adds = collections.defaultdict(list)
    for src, kind, t, r in R:
        if kind == "add": adds[(src, t["date"], t["sym"], t["right"])].append((t, r))
    trades, paths, fills = [], [], collections.defaultdict(list)
    for src, kind, t, r in R:
        if kind != "main": continue
        lm = legs_of(r)
        c = (r["contract"], sim_expiry(r["contract"]))
        for slug in V:
            base = f"{slug}-{t['date']}-{t['sym']}-{t['right']}-{t['minute']}"
            legs = [(t, c, lm[slug], False, base)]
            if r["d2"]:
                for a, ar in sorted(adds.get((src, t["date"], t["sym"], t["right"]), []), key=lambda x: int(x[0]["minute"])):
                    if int(a["minute"]) <= int(t["minute"]): continue
                    held = r["walked"][slug][2] if slug in r.get("walked", {}) else r["held"]
                    share, up = held.get(int(a["minute"]), (0, None))
                    if share > 0 and up is not None and up > 0:
                        legs.append((a, (ar["contract"], sim_expiry(ar["contract"])), legs_of(ar)[slug], True, f"{base}+add"))
                    break
            for lt, lc, (paid, steps), half, key in legs:
                w = {m: (paid, steps) for m in ("f2", "f5", "f10", "real")}
                w["cov"] = 1
                row, path, fl = ec.rows_of(slug, lt, lc, w, half, key)
                pres = [""] if src == "fair" else [f"{p}:" for p, a in (("fav12", fb.A12), ("fav6", fb.A6)) if lt["date"] >= a]
                for pre in pres:
                    trades.append(dict(row, version=pre + slug, key=pre + key))
                    paths.append(dict(path, key=pre + key))
                    for m in ("f5", "f10", "real"): fills[m].append(dict(fl[m], key=pre + key))
                    fills["fair"].append(dict(key=pre + key, buy_m=steps[0][1], buy_px=paid, **{k: v for k, v in fl["real"].items() if k.startswith("ret")}))
    for fname, data in [("early_trades.csv", trades), ("early_paths.csv", paths)] + [(f"early_fills_{m}.csv", v) for m, v in fills.items()]:
        with open(f"{out}/{fname}", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys())); w.writeheader(); w.writerows(data)
        print(fname, len(data), "rows", flush=True)


def sim_expiry(contract):
    occ = contract[-15:]
    return f"20{occ[:2]}-{occ[2:4]}-{occ[4:6]}"


if __name__ == "__main__":
    main()
