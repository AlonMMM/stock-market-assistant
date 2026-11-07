"""e on 2022-23, the last feature test (the user, 2026-11-07: "Go." to "run e (and 2.10 next to it) on 2022-23 first";
2022-23 is never tuned on, read as a warning sign, not a pass / fail). dbx22.py's data (real Databento quotes, minute
fills) and the static lists of the 2.10 run there (hot_static_2022_2023.json, 56 / 75 names), each year its own
$100,000 account. Versions, as add_small.py on 2024-26:
  base  2.10 (2.9's exits + t3A-c5 sizing; reproduces trades_v210x / summary_v210x)
  c212  2.12: + a 50% add once the stock is +1.0 S30 our way within 10 minutes
  d     the 25% add + S03h
  e     d, a small entry (0.5 tier) adds 100%, never past 2x the first leg
Every drop booked (equity moves on the sale day) and marked.

  node --env-file=.env <dir>/run.mjs e2223.py 2022      (then 2023; from the app repo root)
-> data/local/x/bt/y<year>/e2223_summary.json
"""
import collections, json, multiprocessing as mp, os, sys
YEAR = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import size_volume as SV   # sets 2.9's exits (BT_X) before sim is imported
sys.argv = [sys.argv[0], YEAR]
import dbx22 as DX   # wires the year's options, chains and quotes into store / real_bench
import add_small as AS
import sim
import opt_spread as OS
from d2_failed_break import CHAMP

HOT = json.load(open("data/local/x/bt/hot_static_2022_2023.json"))
VERS = ("c212", "d", "e")
MODES = ("base-c5",) + tuple(f"{k}-c5" for k in VERS)


def one(t):
    m = int(t["minute"])
    c = DX.pick(t)
    if not c: return None
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], DX.CAL)
    if cost is None: return None
    rcost, _ = OS.price(steps, c[0], cost, "bid")
    base = AS.walk(t, m, c, rcost, None)
    if base is None: return None
    rv = float(t.get("c_rvol") or 0)
    rows = {"base-c5": AS.row(t, m, c, rcost, base)}
    for k in VERS:
        s_ = AS.walk(t, m, c, rcost, AS.over_for(k, t["kind"], rv)) if t["kind"] == "main" else None
        rows[f"{k}-c5"] = {**(AS.row(t, m, c, rcost, s_) if s_ else rows["base-c5"]), "share": AS.share_for(k, rv)}
    return dict(src="y", kind=t["kind"], date=t["date"], minute=m, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=rv, v=rows, at={v: m for v in rows})


def booked_dd(E, size):
    """SV.account's stakes, but the equity counted only on sale days: the worst drop of booked money."""
    by = collections.defaultdict(list)
    for e in E: by[e[0]].append(e)
    days = sorted(set(by) | {e[5]["exit_day"] or e[0] for e in E})
    eq, peak, dd, open_, prev = 1e5, 1e5, 0.0, [], None
    for d in days:
        base = eq + sum(st_ * e[2] * (e[5]["marks"] or {}).get(prev, 0.0) for st_, e in open_)
        for e in by.get(d, []): open_.append((size * base, e))
        keep = []
        for st_, e in open_:
            if (e[5]["exit_day"] or e[0]) == d: eq += st_ * e[2] * max(-1, e[3])
            else: keep.append((st_, e))
        open_ = keep
        peak = max(peak, eq); dd = max(dd, 1 - eq / peak); prev = d
    return dd


def main():
    S = [t for t in DX.signals() if t["sym"] in HOT.get(t["date"][:7], ())]
    main_ok = [t for t in S if t["kind"] == "add" or t["news_ok"]]
    print(len(main_ok), "signals on the static list", flush=True)
    with mp.get_context("fork").Pool(8) as pool: R = [r for r in pool.map(one, main_ok, chunksize=8) if r]
    json.dump([dict(kind=r["kind"], date=r["date"], sym=r["sym"], right=r["right"], minute=r["minute"], rvol=r["rvol"], d2=r["d2"],
                    **{v: r["v"][v]["r2"] for v in MODES}) for r in R], open(f"{DX.D}/e2223_rows.json", "w"))
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[("y", r["date"], r["sym"], r["right"])].append(r)
    out = {}
    for size in (0.02, 0.03):
        print(f"\n### {YEAR}, the static list, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | Trades | Winners | Median | Per trade at $10K | End / marked drop | **Booked drop** | vs 2.10 | Without the best 5 | Best 5 | Giants · non-giant sum |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for v in MODES:
            E = AS.entries(R, adds, "y", v, "all", size)
            s = SV.stats(E, size); s["bdd"] = round(booked_dd(E, size), 3)
            s["top"] = [(e[0], round(1e4 * e[2] * e[3])) for e in sorted(E, key=lambda e: -e[2] * e[3])[:5]]
            out[f"{v}|{size}"] = s
            b = out[f"base-c5|{size}"]
            print(f"| {v} | {s['trades']} | {s['win']:.1%} | {s['median']:+,} | {s['per']:+,} | ${s['acct']:,} / {s['dd']:.1%} | **{s['bdd']:.1%}** | {s['acct'] / b['acct']:.3f} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} |", flush=True)
    # the main legs the add changed (at $10K, 1%)
    for v in MODES[1:]:
        ch = [r for r in R if r["kind"] == "main" and r["v"][v].get("added")]
        b = [1e4 * max(-1, r["v"]["base-c5"]["r1"]) for r in ch]; l = [1e4 * max(-1, r["v"][v]["r1"]) for r in ch]
        best = sorted(zip(ch, b, l), key=lambda z: -abs(z[2] - z[1]))[:5]
        print(f"\n{v}: {len(ch)} main legs added; 2.10 {sum(b):+,.0f} -> {sum(l):+,.0f} at $10K; biggest changes:",
              ", ".join(f"{r['sym']} {r['date']} {x:+,.0f} -> {y:+,.0f}" for r, x, y in best), flush=True)
    json.dump(out, open(f"{DX.D}/e2223_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
