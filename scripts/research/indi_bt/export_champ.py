"""The new champion and its neighbours for the Bot vs Indi dashboard (the user, 2026-10-27: "OK for now lets make this
our champion ... show me all in the report benchmark"), in export_bench.py's trades / paths / bars shapes and
fill_models.py's fills shapes, on the fair list and the Favorites (fav12: / fav6:, fav_bench.py's signals):
  d25-ibit   2.5 + IBIT bought down to $0.10 (floor_exception.py "ibit", no cheap fallback)
  pyr        the pyramid on 2.6 (the half-size add on 2.4's entry while the D2 leg is held and up on the real mid)
  pyr-nc     the pyramid on 2.5, no cheap fallback on either leg
  champ      THE CHAMPION: the pyramid on 2.5 + IBIT at $0.10, no cheap fallback
An add is its own row (key ...+add, exit words "Add, half size: ..."): its returns are half the return at half the
size, so the dashboard's account sizing reads it as half a trade. Whether an add is taken is decided on the real mid
(as in the research), so the same trades are shown at every fill price.

  node --env-file=.env <dir>/run.mjs export_champ.py <out dir>      (from the app repo root)
-> <out>/champ_trades.csv, champ_paths.csv, champ_bars.csv, champ_fills_f5.csv, champ_fills_f10.csv, champ_fills_real.csv
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import export_bench as eb
import fav_bench as fb
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from store import day

CAL = eb.CAL
SIZES = (0.01, 0.02, 0.04, 0.05)
# slug -> (name, IBIT floor exception, cheap fallback, pyramid)
V = {"d25-ibit": ("2.5 + IBIT down to $0.10", True, False, False),
     "pyr": ("Pyramid on 2.6 (with the cheap fallback)", False, True, True),
     "pyr-nc": ("Pyramid on 2.5, no cheap fallback", False, False, True),
     "champ": ("Champion: 2.5 + IBIT $0.10 + the pyramid", True, False, True)}
CONFIGS = sorted({(v[1], v[2]) for v in V.values()})


def rets(cost, steps, half):
    """Returns at each size (half: an add, half a trade at half the size)."""
    k = 0.5 if half else 1.0
    r = {("ret" if s == 0.01 else f"ret_{round(s * 100)}pct"): round(k * sim.result(cost, steps, s * k), 4) for s in SIZES}
    r["ret_nocap"] = round(k * sim.result(cost, steps, 0), 4)
    return r


def stepstr(steps): return ";".join(f"{s[0]},{s[1]},{s[2]},{s[3]},{s[4]},{s[5]}" for s in steps)


def walk_all(t, c):
    """The trade at +-2% (with its path), +-5%, +-10% and on the real book, and the real mid held/up map."""
    m0 = int(t["minute"])
    sim.X.clear(); sim.X.update(CHAMP)
    out = {}
    for model, sh in (("f5", 0.05), ("f10", 0.10), ("f2", 0.02)):
        sim.SH = sh
        cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], c[0], c[1], CAL)
        if cost is None: return None
        out[model] = (cost, steps)
    cost, steps = out["f2"]
    rcost, real = OS.price(steps, c[0], cost, "bid")
    out["real"] = (rcost, real)
    fills = [s for s in steps if s[2] in ("buy", "sell")]
    out["cov"] = round(sum(bool(RB.quote(c[0], s[0], max(s[1] - 1, 0))) for s in fills) / len(fills), 2)
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    held = {}
    for mm in range(m0, 390):
        k = RB.quote(c[0], t["date"], mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    out["held"] = held
    return out


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    cands = cu.candidates(t["sym"], t["date"], int(t["minute"]), t["right"], float(t["price"]))
    res, done = {}, {}
    for ibit, cheap in CONFIGS:
        floor = 0.10 if ibit and t["sym"] == "IBIT" else 0.20
        p = fe.choose(cands, floor, "cheap" if cheap else "none")
        if not p: continue
        c = p[0]
        if c[0] not in done: done[c[0]] = walk_all(t, c)
        if done[c[0]]: res[(ibit, cheap)] = (c, done[c[0]])
    return src, kind, t, res


def rows_of(slug, t, c, w, half, key):
    name = V[slug][0]
    cost, steps = w["f2"]
    last = [s for s in steps if s[2] == "sell"][-1]
    pre = "Add, half size: " if half else ""
    row = dict(version=slug, key=key, date=t["date"], time=t["time"], minute=int(t["minute"]), sym=t["sym"], right=t["right"], contract=c[0],
               iv=t.get("iv", ""), exit=pre + eb.words(steps), overnight=int(last[0] != t["date"]), added=int(half), **rets(cost, steps, half))
    days = [d for d in CAL if t["date"] <= d <= last[0]]
    m0 = int(t["minute"])
    opt = "|".join(f"{d}: " + " ".join(eb.closes5([b for b in day(c[0], d) if d != t["date"] or b[0] >= m0])) for d in days)
    after = "|".join(f"{d}: " + " ".join(eb.closes5(day(t["sym"], d))) for d in days[1:])
    path = dict(key=key, cost=round(cost, 4), steps=stepstr(steps), option=opt, stock_after=after)
    fills = {}
    for model in ("f5", "f10", "real"):
        mc, ms = w[model]
        ml = [s for s in ms if s[2] == "sell"][-1]
        f = dict(key=key, cost=round(mc, 4), **{k: v for k, v in rets(mc, ms, half).items() if k != "ret_nocap"}, exit=pre + eb.words(ms),
                 overnight=int(ml[0] != t["date"]), steps=stepstr(ms))
        if model == "real": f["cov"] = w["cov"]
        fills[model] = f
    return row, path, fills


def main():
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    S = fb.signals()
    fair_add = [t for f in glob.glob(f"{eb.B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    eb.nf.features(fair_add)
    fair_add = [t for t in fair_add if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in eb.HIS40 and t["sym"] in eb.PRIOR[t["date"][:4]]]
    jobs = [("fair", "main", t) for t in S[("fair", "sg_c12_15")]] + [("fair", "add", t) for t in fair_add]
    jobs += [("fav", "main", t) for t in S[("fav", "sg_c12_15")]] + [("fav", "add", t) for t in S[("fav", "s_t18r15")]]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = pool.map(one, jobs, chunksize=4)
    trades, paths, fills = [], [], {"f5": [], "f10": [], "real": []}
    adds = {}
    for src, kind, t, res in R:
        if kind == "add": adds.setdefault((src, t["date"], t["sym"], t["right"]), []).append((t, res))
    for src, kind, t, res in R:
        if kind != "main": continue
        for slug, (name, ibit, cheap, pyr) in V.items():
            if (ibit, cheap) not in res: continue
            c, w = res[(ibit, cheap)]
            base = f"{slug}-{t['date']}-{t['sym']}-{t['right']}-{t['minute']}"
            legs = [(t, c, w, False, base)]
            if pyr and float(t.get("c_t") or 9) < 1.8:
                for a, ares in sorted(adds.get((src, t["date"], t["sym"], t["right"]), []), key=lambda x: int(x[0]["minute"])):
                    if int(a["minute"]) <= int(t["minute"]) or (ibit, cheap) not in ares: continue
                    share, up = w["held"].get(int(a["minute"]), (0, None))
                    if share > 0 and up is not None and up > 0:
                        ac, aw = ares[(ibit, cheap)]
                        legs.append((a, ac, aw, True, f"{base}+add"))
                    break
            for lt, lc, lw, half, key in legs:
                row, path, fl = rows_of(slug, lt, lc, lw, half, key)
                pres = [("", "")] if src == "fair" else [(f"{p}:", a) for p, a in (("fav12", fb.A12), ("fav6", fb.A6)) if lt["date"] >= a]
                for pre, _ in pres:
                    trades.append(dict(row, version=pre + slug, key=pre + key))
                    paths.append(dict(path, key=pre + key))
                    for m in fills: fills[m].append(dict(fl[m], key=pre + key))
    keys = set()
    for r in trades:
        i = CAL.index(r["date"])
        for s in (r["sym"], "SPY"): keys.add((s, r["date"], CAL[i - 1]))
    bars = [dict(key=f"{s}|{d}", prev_date=pd, closes=" ".join(eb.closes5(day(s, pd)) + eb.closes5(day(s, d)))) for s, d, pd in sorted(keys)]
    for fname, data in [("champ_trades.csv", trades), ("champ_paths.csv", paths), ("champ_bars.csv", bars)] + [(f"champ_fills_{m}.csv", v) for m, v in fills.items()]:
        with open(f"{out}/{fname}", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys())); w.writeheader(); w.writerows(data)
        print(fname, len(data), "rows", os.path.getsize(f"{out}/{fname}") // 1024, "KB", flush=True)
    for slug in V:
        for pre in ("", "fav12:", "fav6:"): print(pre + slug, sum(r["version"] == pre + slug for r in trades), "rows")


if __name__ == "__main__":
    main()
