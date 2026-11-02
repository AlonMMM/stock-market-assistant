"""A busier strike instead of a thin skip, on the champion 2.10 (the user, 2026-11-02, after the live WMT skip at 15:31 ET:
the 0.15-delta Call 132 6 Nov had 34 contracts in 30 minutes, 128 had 757 and 130 had 457: "do new test." then
"150 contract is enough" and "and go"). When the 0.15-delta pick has under the floor in the last 30 minutes, take a
nearby busier strike of the same expiry instead of skipping; and a 150-contract floor. Set before running:
  champ   2.10 as is (size_volume.py t3A-c5): 2.9's exits, the pyramid, 0.5 / 1 / 1.5 size under 1.75 / 2.5x volume,
          the add within 5% of the account; the 0.15 pick needs 200 contracts, else no trade
  f150    the same pick, the floor 150 instead of 200, no fallback
  A200 / A150   a thin pick -> the nearest strike toward the money with 200 / 150 contracts, delta up to 0.35
  B200 / B150   a thin pick -> the next listed strike on either side (hot_fit_test.adjacent) with 200 / 150, the one
                nearer 0.15 delta
  C150    a thin pick -> a round strike with 150 contracts, delta 0.10 - 0.35, the one nearest 0.15 delta; round =
          a whole dollar under a $25 stock, a multiple of $5 from $25 to $200, a multiple of $10 above $200
The price floor stays $0.20 ($0.10 IBIT) for every pick, a too-cheap pick is not replaced (no cheap fallback, as 2.10).
A fallback trade takes its signal's exits, size and pyramid; the pyramid's add uses the same rule. A pick under 200
contracts (f150, A150, B150, C150) is "fill unproven" beyond the real quotes the walk prices it at.
Lists: the fair list + the Favorites (favorites.txt, 24 months); tune = even entry weeks, check = odd (split.py), in the
same run; one pick per idea (f150 / A / B / C) on tune by min(fair, Favorites) vs champ at 2%; check for champ and the
picks only, at 2% and 3%. Look 1 on the fixed walk (the idea had looks on the old walk: cheap_up.py, cheap_up2.py,
hot_fit_test adj, oi_strike.py).

  node --env-file=.env <dir>/run.mjs thin_strike.py      (from the app repo root)
-> data/local/x/bt/thin_strike_summary.json, thin_strike_added.csv
"""
import collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import size_volume as SV   # sets 2.9's exits (BT_X) before sim is imported
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from score_sum import held as booked
from split import half

B = "data/local/x/bt"
CAL = SV.CAL
MODES = ("champ", "f150", "A200", "A150", "B200", "B150", "C150")
FAMILIES = {"f150": ("f150",), "A": ("A200", "A150"), "B": ("B200", "B150"), "C": ("C150",)}
MAX_DELTA = 0.35
SIZES = {0.02: ("r2", "r1"), 0.03: ("r3", "r15")}
t3A = lambda rv: SV.tier(rv, (1.75, 2.5), (0.5, 1.0, 1.5))


def step_of(spot):
    if spot < 25: return 1.0
    if spot <= 200: return 5.0
    return 10.0


def pick(cands, floor, mode, und, right, spot):
    """-> (candidate, how) or None. how: pick = the 0.15 strike itself, fb = a fallback strike."""
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    if best[4] < floor: return None
    need = 150 if mode in ("f150", "A150", "B150", "C150") else 200
    if best[5] >= need: return best, "pick"
    ok = []
    if mode.startswith("A"):
        ok = [c for c in cands if c[5] >= need and c[4] >= floor and abs(best[3]) <= abs(c[3]) <= MAX_DELTA]
        return (min(ok, key=lambda c: abs(c[3])), "fb") if ok else None
    if mode.startswith("B"):
        ks = sorted(sim.chain(und, best[1], right))
        i = ks.index(best[2])
        near = {ks[j] for j in (i - 1, i + 1) if 0 <= j < len(ks)}
        ok = [c for c in cands if c[2] in near and c[5] >= need and c[4] >= floor]
    if mode == "C150":
        s = step_of(spot)
        ok = [c for c in cands if abs(c[2] / s - round(c[2] / s)) < 1e-6 and 0.10 <= abs(c[3]) <= MAX_DELTA
              and c[5] >= need and c[4] >= floor]
    return (min(ok, key=lambda c: abs(abs(c[3]) - 0.15)), "fb") if ok else None


def walk_c(t, m, c):
    """size_volume.walk_at's walk on a given contract: {r1, r2, r3, r15, over, h, held} or None."""
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL, paid=rcost)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    row = dict(r1=sim.result(rcost, real, 0.01), r2=sim.result(rcost, real, 0.02), r3=sim.result(rcost, real, 0.03),
               r15=sim.result(rcost, real, 0.015), over=int(any(s[2] == "carry" for s in steps)), h=booked(rcost, real))
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    row["held"] = {}
    for mm in range(m, 390):
        k = RB.quote(c[0], t["date"], mm)
        row["held"][mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return row


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
               d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v={}, pick={})
    walked = {}
    for mode in MODES:
        p = pick(cands, floor, mode, t["sym"], t["right"], spot)
        if not p: continue
        c, how = p
        if c[0] not in walked: walked[c[0]] = walk_c(t, m0, c)
        if walked[c[0]] is None: continue
        out["v"][mode] = walked[c[0]]
        out["pick"][mode] = dict(contract=c[0], strike=c[2], delta=round(abs(c[3]), 3), price=c[4], vol30=c[5], how=how)
    return out if out["v"] else None


def entries(R, adds, src, v, part, size, a=""):
    """size_volume.entries for t3A-c5 on any pick rule."""
    full, halfk = SIZES[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x, m = r["v"][v], r["minute"]
        w = t3A(r["rvol"])
        E.append((r["date"], m, w, x[full], x["over"], x["h"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or v not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            aw = min(0.5 * w, max(0.0, 0.05 / size - w))
            if share > 0 and up is not None and up > 0 and aw > 0: E.append((ad["date"], ad["minute"], aw, ad["v"][v][halfk], ad["v"][v]["over"], ad["v"][v]["h"]))
            break
    return E


def table(R, adds, part, out, title, versions):
    for size in SIZES:
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | vs champ | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in versions:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                base = out[f"{part}|champ|{src}|{size}"]["acct"]
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | {s['acct'] / base - 1:+.0%} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)


def added(R, part, out, versions, rows_out):
    """The main legs a version trades that the champion does not, or on another contract: at $10K, 1% basis (r1)."""
    print(f"\n#### {part} weeks: the trades each version added or moved (main legs at $10K)\n")
    print("| Version | List | Added | Winners | Median | Sum | Giants | Non-giant sum | Without their best 5 | Fill unproven (< 200) | By year | Top names |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for v in versions:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            hit = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a
                   and v in r["v"] and r["pick"][v]["contract"] != (r["pick"].get("champ") or {}).get("contract")]
            usd = [1e4 * max(-1, r["v"][v]["r1"]) for r in hit]
            g = [u for r, u in zip(hit, usd) if r["v"][v]["r1"] >= 3.0]
            years = collections.defaultdict(float)
            names = collections.defaultdict(float)
            for r, u in zip(hit, usd): years[r["date"][:4]] += u; names[r["sym"]] += u
            thin = sum(r["pick"][v]["vol30"] < 200 for r in hit)
            no5 = sum(sorted(usd)[:-5]) if len(usd) > 5 else 0
            s = dict(n=len(hit), win=sum(u > 0 for u in usd), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)),
                     giants=len(g), nongiant=round(sum(usd) - sum(g)), no5=round(no5), thin=thin,
                     years={y: round(x) for y, x in sorted(years.items())},
                     top=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: -kv[1])[:4]],
                     bottom=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: kv[1])[:3]])
            out[f"{part}|{v}|{src}|added"] = s
            yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
            print(f"| {v} | {src} | {s['n']} | {s['win']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} | {s['no5']:+,} | {thin} | {yrs} | {', '.join(s['top'])}; worst {', '.join(s['bottom'])} |", flush=True)
            for r, u in zip(hit, usd):
                p = r["pick"][v]; c = r["pick"].get("champ")
                rows_out.append(dict(part=part, version=v, list=src, date=r["date"], minute=r["minute"], sym=r["sym"], right=r["right"],
                                     contract=p["contract"], delta=p["delta"], price=p["price"], vol30=p["vol30"], usd10k=round(u),
                                     champ_contract=(c or {}).get("contract", "")))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    main_thin = [r for r in R if r["kind"] == "main" and "champ" not in r["v"]]
    print(f"{len(R)} rows; main signals with no champion trade but a fallback trade: {len(main_thin)}", flush=True)
    out, rows = {}, []
    table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    picks = {fam: max(vs, key=score) for fam, vs in FAMILIES.items()}
    out["picks"] = picks
    for fam, v in picks.items():
        print(f"\n🎯 {fam}: picked on tune (min of fair and Favorites vs champ, 2%): {v} ({score(v):.3f}); better on both: {score(v) > 1}")
    table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the picks only", ("champ", *picks.values()))
    added(R, "tune", out, MODES[1:], rows)
    added(R, "check", out, tuple(picks.values()), rows)
    wmt = [x for x in rows if x["sym"] == "WMT"]
    print(f"\nWMT trades added or moved: {len(wmt)}", [(x['part'], x['version'], x['date'], x['contract'], x['usd10k']) for x in wmt][:20])
    json.dump(out, open(f"{B}/thin_strike_summary.json", "w"), indent=1)
    with open(f"{B}/thin_strike_added.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
