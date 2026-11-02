"""No volume floor when the spread is tight, on the champion 2.10 (the user, 2026-11-03: "if the spread is lower than 30%
- take the trade with no flor"). The 0.15-delta pick that has under 200 contracts in the last 30 minutes is bought
anyway when its spread at the signal ((ask - bid) / mid on the book at the end of the signal minute, the bot's
spreadPct) is under the line; no quote = no trade. The same contract (no strike change), the $0.20 floor ($0.10 IBIT),
picks with 200+ unchanged, 2.10's exits, size and pyramid (the add uses the same rule). Set before running:
  champ   2.10 as is (thin_strike.py's champ = size_volume.py t3A-c5 after the quote-minute fix)
  S20 / S30 / S40   a thin pick bought when its spread is under 20 / 30 / 40% (S30 = the user's rule)
  S30f50  S30, but the pick still needs 50 contracts in 30 minutes
Every added trade is "fill unproven" (a thin contract; the walk prices it on the real book).
Tried before only as a lower floor with a spread cap (opt_spread.py, 2026-10-26, 2.6, the old walk: floor 100 / 50 with
a 30% cap worse, $309,269 / 15% vs $390,392 / 12%); "no floor under a 30% spread" is new: look 1 on the fixed walk.
Lists: the fair list + the Favorites (24 months); tune = even entry weeks, check = odd (split.py), the same run; one pick
on tune by min(fair, Favorites) vs champ at 2%; check for champ and the pick, at 2% and 3%.

  node --env-file=.env <dir>/run.mjs spread_nofloor.py      (from the app repo root)
-> data/local/x/bt/spread_nofloor_summary.json, spread_nofloor_added.csv
"""
import collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS   # size_volume's 2.9 exits (BT_X), the walk, the entries and the tables
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half

B = "data/local/x/bt"
MODES = ("champ", "S20", "S30", "S40", "S30f50")
LINE = {"S20": 0.20, "S30": 0.30, "S40": 0.40, "S30f50": 0.30}
MIN_VOL = {"S30f50": 50}


def spread_at(c, date, minute):
    q = RB.quote(c, date, minute)
    if not q or not (q[0] > 0 and q[1] > 0): return None
    bid, ask = q
    return (ask - bid) / ((ask + bid) / 2), bid, ask


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    if best[4] < floor: return None
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
               d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v={}, pick={})
    sp = spread_at(best[0], t["date"], m0)
    take = []
    if best[5] >= 200: take = list(MODES)
    elif sp is not None:
        take = [v for v in MODES[1:] if sp[0] < LINE[v] and best[5] >= MIN_VOL.get(v, 0)]
    if not take: return None
    row = TS.walk_c(t, m0, best)
    if row is None: return None
    info = dict(contract=best[0], strike=best[2], delta=round(abs(best[3]), 3), price=best[4], vol30=best[5],
                how="pick" if best[5] >= 200 else "nofloor", spread=None if sp is None else round(sp[0], 4),
                bid=None if sp is None else sp[1], ask=None if sp is None else sp[2])
    for v in take: out["v"][v] = row; out["pick"][v] = info
    return out


def added(R, part, out, versions, rows_out):
    print(f"\n#### {part} weeks: the trades each version added (main legs at $10K; all fill unproven)\n")
    print("| Version | List | Added | Winners | Median | Sum | Giants | Non-giant sum | Without their best 5 | Spread: median · under 10% / 10-20 / 20-30 / 30-40% | Volume 30 min: median | By year | Top names |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for v in versions:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            hit = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a
                   and v in r["v"] and "champ" not in r["v"]]
            usd = [1e4 * max(-1, r["v"][v]["r1"]) for r in hit]
            g = [u for r, u in zip(hit, usd) if r["v"][v]["r1"] >= 3.0]
            years, names = collections.defaultdict(float), collections.defaultdict(float)
            for r, u in zip(hit, usd): years[r["date"][:4]] += u; names[r["sym"]] += u
            sps = [r["pick"][v]["spread"] for r in hit]
            bins = [sum(lo <= x < hi for x in sps) for lo, hi in ((0, .1), (.1, .2), (.2, .3), (.3, .4))]
            s = dict(n=len(hit), win=sum(u > 0 for u in usd), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)),
                     giants=len(g), nongiant=round(sum(usd) - sum(g)), no5=round(sum(sorted(usd)[:-5])) if len(usd) > 5 else 0,
                     spread_median=round(st.median(sps), 3) if sps else None, spread_bins=bins,
                     vol_median=st.median(r["pick"][v]["vol30"] for r in hit) if hit else None,
                     years={y: round(x) for y, x in sorted(years.items())},
                     top=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: -kv[1])[:4]],
                     bottom=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: kv[1])[:3]])
            out[f"{part}|{v}|{src}|added"] = s
            yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
            spt = f"{s['spread_median']:.0%} · {' / '.join(map(str, bins))}" if sps else "—"
            print(f"| {v} | {src} | {s['n']} | {s['win']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} | {s['no5']:+,} | {spt} | {s['vol_median']} | {yrs} | {', '.join(s['top'])}; worst {', '.join(s['bottom'])} |", flush=True)
            for r, u in zip(hit, usd):
                p = r["pick"][v]
                rows_out.append(dict(part=part, version=v, list=src, date=r["date"], minute=r["minute"], sym=r["sym"], right=r["right"],
                                     contract=p["contract"], delta=p["delta"], price=p["price"], vol30=p["vol30"], usd10k=round(u),
                                     champ_contract=p["contract"], champ_skipped=1, spread_pct=round(100 * p["spread"], 2),
                                     bid=p["bid"], ask=p["ask"]))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    print(f"{len(R)} rows; main signals bought only without the floor: {sum(r['kind'] == 'main' and 'champ' not in r['v'] for r in R)}", flush=True)
    out, rows = {}, []
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    pick = max(MODES[1:], key=score)
    out["pick"] = pick
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs champ, 2%): {pick} ({score(pick):.3f}); better on both: {score(pick) > 1}")
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the pick only", ("champ", pick))
    added(R, "tune", out, MODES[1:], rows)
    added(R, "check", out, (pick,), rows)
    json.dump(out, open(f"{B}/spread_nofloor_summary.json", "w"), indent=1)
    with open(f"{B}/spread_nofloor_added.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
