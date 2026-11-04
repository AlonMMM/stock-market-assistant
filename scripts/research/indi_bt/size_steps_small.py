"""Bigger size on a small account (the user, 2026-11-04: "when 10K account sise you can use 5%, on 50K use 4%", then
"more than 100K stay with 3%"). The account steps (versions.ts sizeSteps, the account as the day starts):
  now   3% under $300K, 2.5% from $300K, 1.5% from $1M, 1% from $4M (2.10)
  small 5% under $50K, 4% from $50K, 3% from $100K, then the same steps
The volume tier multiplies the step (50 / 100 / 150%), never over the service's 5% cap per buy; the pyramid add is half
the main leg's, within 5% of the account with its main leg (2.10's c5). On 2.10 (the bid) and the candidate 2.11 (the
sale from the mid over 5 minutes), from $10,000 and from $100,000; tune = even weeks, check = odd, the same run.

  node --env-file=.env <dir>/run.mjs size_steps_small.py      (from the app repo root)
-> data/local/x/bt/size_steps_small_summary.json
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sale_limit as SL
SL.MODES = ("bid-c5", "M5-c5")
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import size_volume as SV
from split import half

B = "data/local/x/bt"
CAP = 0.05
RKEY = ((0.03, "r3"), (0.02, "r2"), (0.015, "r15"), (0.01, "r1"), (0.0, "r05"))   # the overnight cap at the nearest size at or under
STEPS = {"flat3": [(0, 0.03)], "now": [(0, 0.03), (300_000, 0.025), (1_000_000, 0.015), (4_000_000, 0.01)],
         "small": [(0, 0.05), (50_000, 0.04), (100_000, 0.03), (300_000, 0.025), (1_000_000, 0.015), (4_000_000, 0.01)]}


def step(steps, acct):
    p = steps[0][1]
    for frm, pct in steps:
        if acct >= frm: p = pct
    return p


def legs(R, adds, src, v, part, a=""):
    """2.10's legs: (date, minute, w, ret at full size, h, main id, is add)."""
    E = []
    for i, r in enumerate(R):
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x, m = r["v"][v], r["at"][v]
        w = SV.tier(r.get("rvol", 0), (1.75, 2.5), (0.5, 1.0, 1.5))
        E.append((r["date"], m, w, x, x["h"], i, False))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or v not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5 * w, ad["v"][v], ad["v"][v]["h"], i, True))
            break
    return sorted(E, key=lambda e: e[:2])


def account(E, steps, start):
    """The account (marked, booked on the sale day); each leg's share of the day's opening account from the step at
    that account x the volume tier, capped at 5% a buy and 5% with its main leg. r1 is the return at 1% with the
    overnight cap, so a leg's money = its share x the account x r1 / ... (r1 is per $ of stake, capped at -1)."""
    by = collections.defaultdict(list)
    for e in E: by[e[0]].append(e)
    days = sorted(set(by) | {e[4]["exit_day"] or e[0] for e in E})
    eq, peak, dd, open_, prev, main_frac = start, start, 0.0, [], None, {}
    for d in days:
        base = eq + sum(stake * e[4]["marks"].get(prev, 0.0) for stake, e, _ in open_)
        p = step(steps, base)
        for e in by.get(d, []):
            if e[6]: f = max(0.0, min(p * e[2], CAP - main_frac.get(e[5], 0.0)))
            else: f = min(p * e[2], CAP); main_frac[e[5]] = f
            if f > 0: open_.append((f * base, e, next(k for lv, k in RKEY if f >= lv - 1e-9)))
        keep = []
        for stake, e, k in open_:
            if (e[4]["exit_day"] or e[0]) == d: eq += stake * max(-1.0, e[3][k])
            else: keep.append((stake, e, k))
        open_ = keep
        now = eq + sum(stake * e[4]["marks"].get(d, 0.0) for stake, e, _ in open_)
        peak = max(peak, now); dd = max(dd, 1 - now / peak); prev = d
    return eq + sum(stake * max(-1.0, e[3][k]) for stake, e, k in open_), dd


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(SL.one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    for part in ("tune", "check"):
        print(f"\n### {part.capitalize()} weeks, real quotes: end / worst drop\n")
        print("| Bot | Start | List | Steps now (3%) | Small steps (5 / 4 / 3%) | Small vs now | Without the best 5: now / small |")
        print("|---|---|---|---|---|---|---|")
        for v, name in (("bid-c5", "2.10"), ("M5-c5", "2.11 cand.")):
            for start in (10_000, 100_000):
                for src, a in (("fair", ""), ("fav", FR.A24)):
                    E = legs(R, adds, src, v, part, a)
                    top = set(sorted(range(len(E)), key=lambda i: -E[i][2] * E[i][3]["r1"])[:5])
                    E5 = [e for i, e in enumerate(E) if i not in top]
                    s = {k: account(E, st_, start) for k, st_ in STEPS.items()}
                    s5 = {k: account(E5, st_, start)[0] for k, st_ in STEPS.items()}
                    out[f"{part}|{v}|{start}|{src}"] = dict(now=s["now"], small=s["small"], no5=s5)
                    if start == 100_000: print(f"  (reproduction, flat 3%: ${s['flat3'][0]:,.0f} / {s['flat3'][1]:.0%})", flush=True)
                    print(f"| {name} | ${start:,} | {src} | ${s['now'][0]:,.0f} / {s['now'][1]:.0%} | ${s['small'][0]:,.0f} / {s['small'][1]:.0%} | {s['small'][0] / s['now'][0]:.3f} | ${s5['now']:,.0f} / ${s5['small']:,.0f} |", flush=True)
    json.dump(out, open(f"{B}/size_steps_small_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
