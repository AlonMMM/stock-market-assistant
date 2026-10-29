"""The overnight hold by the stock's strength (the user, 2026-10-28: "go over the night depend on the streight. 1. if vs
spy t <=1 or D< -1 go over night from 1.1 100% 1.2 200% 1.3 do not go over nitgh 2. if the t >= 1.4 or D >= 1 go 2.1 from
20% 2.2 anyway"). On the champion of retry_roll.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes; it holds a
position up +50% at 15:50). At each 15:50 hold decision (sim.py carry_strength), on the bet's side: t = the day's t vs
SPY x beta, D2 = the excess on SPY's bad minutes of the last 30 (S30 units, defence_signals.py).
  weak    t <= 1 or D2 < -1 (checked first)  -> hold from +100% / +200% / never
  strong  t >= 1.4 or D2 >= 1                 -> hold from +20% / at any gain ("anyway")
  between                                     -> the champion's +50%
Set before running: the 6 combinations, the champion beside them. Every hold decision follows the rule (each night).
One run, tune AND check (split.py), fair list + Favorites 24m, 2% and 3%; the pick on tune by min(fair, Favorites) money.

  node --env-file=.env <dir>/run.mjs night_strength.py      (from the app repo root)
"""
import collections, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from d2_failed_break import CHAMP
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
CS = dict(weak_t=1.0, weak_d=-1.0, strong_t=1.4, strong_d=1.0)
WEAK = {"w100": 1.0, "w200": 2.0, "wnever": 99.0}
STRONG = {"s20": 0.2, "sany": -99.0}
VERSIONS = {"champion": CHAMP, **{f"{w}-{s}": {**CHAMP, "carry_strength": {**CS, "weak_gain": wg, "strong_gain": sg}}
                                  for w, wg in WEAK.items() for s, sg in STRONG.items()}}
# NS_SET=sign (the user, 2026-10-28: "check it with t<0 or t >0 for call and put at 15:50"): only the sign of t on the
# bet's side at 15:50 (a call t > 0, a put t < 0 is "with us"; D2 not used). t <= 0 -> hold from weak_gain, t > 0 -> strong_gain
SIGN = dict(weak_t=0.0, weak_d=-1e9, strong_t=0.0, strong_d=1e9)
if os.environ.get("NS_SET") == "sign":
    VERSIONS = {"champion": CHAMP,
                "sign-50": {**CHAMP, "carry_strength": {**SIGN, "weak_gain": 99.0, "strong_gain": 0.5}},    # +50% and t with us
                "sign-20": {**CHAMP, "carry_strength": {**SIGN, "weak_gain": 99.0, "strong_gain": 0.2}},    # t with us from +20%
                "sign-any": {**CHAMP, "carry_strength": {**SIGN, "weak_gain": 99.0, "strong_gain": -99.0}}, # t with us, any gain
                "sign-100": {**CHAMP, "carry_strength": {**SIGN, "weak_gain": 1.0, "strong_gain": 0.5}}}    # t against us: from +100%
# NS_SET=night2 (the user, 2026-10-28, after the night distribution: the 2nd night wins ~1 in 3): no second night, or
# only part of the position held into it (sold at the 15:50 bid of day 2); 0.25 kept is the neighbour
if os.environ.get("NS_SET") == "night2":
    VERSIONS = {"champion": CHAMP, "no-2nd": {**CHAMP, "carry_max_days": 1},
                "half-2nd": {**CHAMP, "night2_keep": 0.5}, "quarter-2nd": {**CHAMP, "night2_keep": 0.25}}


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8), v={})
    mids = None
    for v, ex in VERSIONS.items():
        g = rr.leg(sym, date, m0, right, c, ex)
        if not g: continue
        rcost, real, _ = g
        sells = [s for s in real if s[2] == "sell"]
        r = dict(r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                 over=int(any(s[0] != date for s in sells)), exits=collections.Counter(s[5] for s in real if s[2] in ("sell", "carry")))
        if kind == "main":
            if mids is None:
                mids = {}
                for mm in range(m0, 390):
                    k = RB.quote(c[0], date, mm)
                    mids[mm] = None if not k else (k[0] + k[1]) / 2
            r["held"] = {mm: (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if p is None else p / rcost - 1) for mm, p in mids.items()}
        out["v"][v] = r
    return out if out["v"] else None


def entries(R, adds, src, v, part, size, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x = r["v"][v]
        E.append((r["date"], r["minute"], 1.0, x["r"][size], x["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0 and v in ad["v"]: E.append((ad["date"], ad["minute"], 0.5, ad["v"][v]["h"][size], ad["v"][v]["over"]))
            break
    return E


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    L = (("fair", ""), ("fav", FR.A24))
    out = {(s, p, v): [rr.stats(entries(R, adds, src, v, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in VERSIONS}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) | Trades tune (fair / fav) |\n|---|---|---|---|---|---|---|---|")
        for v in VERSIONS:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} | {tf['trades']} / {tv['trades']} |", flush=True)
    b = out[(0.02, "tune", "champion")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max((v for v in VERSIONS if v != "champion"), key=sc)
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f})")
    for src in ("fair", "fav"):
        ex = {v: sum((r["v"][v]["exits"] for r in R if r["src"] == src and r["kind"] == "main" and v in r["v"] and half(r["date"]) == "tune"), collections.Counter()) for v in VERSIONS}
        print(f"hold decisions, tune mains, {src}: " + " | ".join(f"{v}: " + ", ".join(f"{k} {n}" for k, n in sorted(ex[v].items()) if k.startswith("eod_") or k == "N2_trim") for v in VERSIONS))
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/night_strength_summary{os.environ.get('NS_SET', '')}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
