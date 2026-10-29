"""Size by the pre-market move (the user, 2026-10-28: "Yes", after pre_agree.py: on the tune weeks every dollar of the
champion's profit came from trades whose stock had moved 1-3 S30 our way from the day before's close to 09:29; the flat
or against trades lost, 3+ was positive only through its best trades).

On the champion of retry_roll.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes). move = the last pre-market
close (premarket_d2.py table prem, 08:00-09:29 New York) over the day before's close, in the stock's S30 units, on the
trade's side; a trade without a pre-market reading keeps full size. Set before running (the buckets picked on tune):
  size-13    full size when 1 <= move < 3, half size otherwise
  size-1+    full size when move >= 1, half otherwise
  skip-flat  no trade when move < 1, full size otherwise
  boost-13   1.5x size when 1 <= move < 3, full otherwise
A trade's size scales its pyramid add the same way; the 10% overnight cap is applied at each trade's own size. One run,
tune AND check (split.py), fair list + Favorites 24m, 2% and 3%, picked on tune by min(fair, Favorites) money.

  node --env-file=.env <dir>/run.mjs pre_size.py      (from the app repo root)
"""
import collections, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import premarket_d2 as pd
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half
from store import day

B = "data/local/x/bt"
SIZES = rr.SIZES
MULTS = (0.5, 1.0, 1.5)
VERSIONS = {"base": lambda m: 1.0,
            "size-13": lambda m: 1.0 if m is None or 1 <= m < 3 else 0.5,
            "size-1+": lambda m: 1.0 if m is None or m >= 1 else 0.5,
            "skip-flat": lambda m: 1.0 if m is None or m >= 1 else 0.0,
            "boost-13": lambda m: 1.5 if m is not None and 1 <= m < 3 else 1.0}


def move(sym, date, right):
    pre = [x for x in pd.prem(sym, date) if x]
    i = rr.CAL.index(date); prev = day(sym, rr.CAL[i - 1]); cx = pd.ctx(sym, date)
    if not (pre and prev and cx and cx["sd"]): return None
    return (1 if right == "C" else -1) * (pre[-1] / prev[-1][4] - 1) / cx["sd"]


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    rcost, real, _ = g
    sells = [s for s in real if s[2] == "sell"]
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8),
               r={(s, k): sim.result(rcost, real, s * k) for s in SIZES for k in MULTS + (0.25, 0.75)},
               over=int(any(s[0] != date for s in sells)))
    if kind == "add": return out
    out["move"] = move(sym, date, right)
    held = {}
    for mm in range(m0, 390):
        q = RB.quote(c[0], date, mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
    out["held"] = held
    return out


def entries(R, adds, src, v, part, size, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        k = VERSIONS[v](r["move"])
        if k == 0: continue
        E.append((r["date"], r["minute"], k, r["r"][(size, k)], r["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"]: continue
            share, up = r["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5 * k, ad["r"][(size, 0.5 * k)], ad["over"]))
            break
    return E


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    M = [r for r in R if r["kind"] == "main"]
    for src, a in (("fair", ""), ("fav", FR.A24)):
        for part in ("tune", "check"):
            X = [r for r in M if r["src"] == src and half(r["date"]) == part and r["date"] >= a]
            print(f"{src} {part}: {len(X)} trades; move 1-3: {sum(r['move'] is not None and 1 <= r['move'] < 3 for r in X)}, >= 3: "
                  f"{sum(r['move'] is not None and r['move'] >= 3 for r in X)}, < 1: {sum(r['move'] is not None and r['move'] < 1 for r in X)}, no reading: {sum(r['move'] is None for r in X)}", flush=True)
    L = (("fair", ""), ("fav", FR.A24))
    out = {(s, p, v): [rr.stats(entries(R, adds, src, v, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in VERSIONS}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) |\n|---|---|---|---|---|---|---|")
        for v in VERSIONS:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} |", flush=True)
    b = out[(0.02, "tune", "base")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max((v for v in VERSIONS if v != "base"), key=sc)
    bc, pc = out[(0.02, "check", "base")], out[(0.02, "check", best)]
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
          f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}")
    # the buckets on the check weeks (the diagnostic was tune only), $ at $10K
    for src, a in L:
        X = [r for r in M if r["src"] == src and half(r["date"]) == "check" and r["date"] >= a]
        for lab, f in (("< 1", lambda m: m < 1), ("1-3", lambda m: 1 <= m < 3), (">= 3", lambda m: m >= 3)):
            Y = sorted(1e4 * max(-1, r["r"][(0.02, 1.0)]) for r in X if r["move"] is not None and f(r["move"]))
            print(f"check {src} move {lab}: {len(Y)} trades, {sum(y > 0 for y in Y)} winners, sum {sum(Y):+,.0f}, without the best 3 {sum(Y[:-3]):+,.0f}", flush=True)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/pre_size_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
