"""The Favorites over 2 and 3 years on the Bot vs Indi dashboard (the user, 2026-10-27: "also add favorite 3 years and 2
yers"): today's 69 Favorites, signals from lists.py over three years (fav69_24 / fav69_25 for Oct 2023 - Oct 2024 and
Oct 2024 - Oct 2025; fav68_* + tsem_* for the last year, fav_real.py's), real quotes from dbx_cache/fav (fav_dbx.py).
Versions: bot24 (2.4), d2-bonus (2.5), d25-cheap (2.6), champ (the champion: IBIT down to $0.10, no cheap fallback, the
pyramid). Lists fav24: (from 2024-10-23) and fav36: (from 2023-10-23), in export_champ.py's shapes: trades, paths and the
fills at +-5%, +-10% and on the real book.

  node --env-file=.env <dir>/run.mjs export_fav_long.py <out dir>      (from the app repo root)
-> <out>/favlong_trades.csv, favlong_paths.csv, favlong_bars.csv, favlong_fills_{f5,f10,real}.csv
"""
import collections, csv, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import cheap_up2 as cu2
import export_bench as eb
import export_champ as ec
import fav_real as FR
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from store import day

CAL = eb.CAL
RB.DBX = os.path.join(HERE, "dbx_cache", "fav")
A36, A24 = "2023-10-23", "2024-10-23"
Y3 = {"24": ("fav69_24", A36, "2024-10-22"), "25": ("fav69_25", A36, "2024-10-22")}
STATUS = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}
# slug -> (entry list, exits, pick, pyramid)
V = {"bot24": ("24", cu2.BOT24, "plain", False), "d2-bonus": ("25", CHAMP, "plain", False),
     "d25-cheap": ("25", CHAMP, "cheap", False), "champ": ("25", CHAMP, "ibit", True)}
for slug in V: ec.V.setdefault(slug, (slug,))


def signals(entry):
    return FR.signals(entry, since=A36)   # the research Favorites (favorites.txt) over the three years


def walk(t, c, exits):
    sim.X.clear(); sim.X.update(exits)
    m0 = int(t["minute"])
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
    kind, t = job   # kind: e24 / e25 (an entry of that list)
    res = {}
    cands = None
    for slug, (entry, exits, pick, pyr) in V.items():
        if f"e{entry}" != kind and not (pyr and kind == "e24"): continue
        if pick == "ibit":
            if cands is None: cands = cu.candidates(t["sym"], t["date"], int(t["minute"]), t["right"], float(t["price"]))
            p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
            c = (p[0][0], p[0][1]) if p else None
        else:
            if t["status"] != "ok" and pick == "plain": continue
            c = eb.contract(t, "cheap" if pick == "cheap" else None)
        if not c: continue
        w = walk(t, c, exits)
        if w: res[slug] = (c, w)
    return kind, t, res


def main():
    out = sys.argv[1]
    S24, S25 = signals("24"), signals("25")
    jobs = [("e24", t) for t in S24] + [("e25", t) for t in S25]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = pool.map(one, jobs, chunksize=4)
    adds = collections.defaultdict(list)
    for kind, t, res in R:
        if kind == "e24" and "champ" in res: adds[(t["date"], t["sym"], t["right"])].append((t, res["champ"]))
    trades, paths, fills = [], [], collections.defaultdict(list)
    for kind, t, res in R:
        for slug, (entry, exits, pick, pyr) in V.items():
            if f"e{entry}" != kind or slug not in res: continue
            c, w = res[slug]
            base = f"{slug}-{t['date']}-{t['sym']}-{t['right']}-{t['minute']}"
            legs = [(t, c, w, False, base)]
            if pyr and float(t.get("c_t") or 9) < 1.8:
                for a, (ac, aw) in sorted(adds.get((t["date"], t["sym"], t["right"]), []), key=lambda x: int(x[0]["minute"])):
                    if int(a["minute"]) <= int(t["minute"]): continue
                    share, up = w["held"].get(int(a["minute"]), (0, None))
                    if share > 0 and up is not None and up > 0: legs.append((a, ac, aw, True, f"{base}+add"))
                    break
            for lt, lc, lw, half, key in legs:
                row, path, fl = ec.rows_of(slug, lt, lc, lw, half, key)
                for pre, a in (("fav36", A36), ("fav24", A24)):
                    if lt["date"] < a: continue
                    trades.append(dict(row, version=f"{pre}:{slug}", key=f"{pre}:{key}"))
                    paths.append(dict(path, key=f"{pre}:{key}"))
                    for m in ("f5", "f10", "real"): fills[m].append(dict(fl[m], key=f"{pre}:{key}"))
    keys = set()
    for r in trades:
        i = CAL.index(r["date"])
        for s in (r["sym"], "SPY"): keys.add((s, r["date"], CAL[i - 1]))
    bars = [dict(key=f"{s}|{d}", prev_date=pd, closes=" ".join(eb.closes5(day(s, pd)) + eb.closes5(day(s, d)))) for s, d, pd in sorted(keys)]
    for fname, data in [("favlong_trades.csv", trades), ("favlong_paths.csv", paths), ("favlong_bars.csv", bars)] + [(f"favlong_fills_{m}.csv", v) for m, v in fills.items()]:
        with open(f"{out}/{fname}", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys())); w.writeheader(); w.writerows(data)
        print(fname, len(data), "rows", os.path.getsize(f"{out}/{fname}") // 1024, "KB", flush=True)
    for slug in V:
        for pre in ("fav24", "fav36"): print(f"{pre}:{slug}", sum(r["version"] == f"{pre}:{slug}" for r in trades), "rows")


if __name__ == "__main__":
    main()
