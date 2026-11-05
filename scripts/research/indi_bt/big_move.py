"""Big move vs its usual move (the user, 2026-11-04: "mainly I would like to test a lock with stages when the stock raised
much motr than her usual, specally on day overnight. for example, in overnight trade if stock raised 5% but it used to more
1% in a day - you can sell half"; 2026-11-05: "lets search for lock gain strategy"). Built on 2.10 (size_volume t3A-c5,
as lock_gain.py; sales at the bid). The move is counted in the stock's usual daily move (sim.usual_move: the mean
|close-to-close| over the 20 sessions before). 2.10 already sells half at 09:40 on a gap of +0.5% our way (all on less).
Set before running, four ideas, one pick each on tune by min(fair, Favorites) vs 2.10 at 2%; the picks run on check:
  G  on top of the morning rule, a carried day's first bar vs yesterday's close (sim `big_move.open`):
     G2h z >= 2 -> half sold at the open · G3h z >= 3 -> half (the user's 5% vs 1%) · G3q z >= 3 -> 75%
  M  the 09:40 morning sale's share by the gap in usual moves (sim `gap_z`), else 2.10's half:
     M2q z >= 2 -> 75% · M3q z >= 3 -> 75% · M3a z >= 3 -> all
  S  stages on any day held, the stock vs the entry price (sim `big_move.entry`):
     S2h z >= 2 -> half · S3h z >= 3 -> half · S23 z >= 2 -> a third, z >= 3 -> two thirds
  L  the option-gain ladders of lock_gain.py whose check was never run: L13, L04, L09
Tune = even weeks, check = odd (split.py), in the same run.

  node --env-file=.env <dir>/run.mjs big_move.py      (from the app repo root)
-> data/local/x/bt/big_move_summary.json
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import size_volume as SV   # sets 2.9's exits (BT_X); 2.10 = its t3A-c5 sizing
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
R_ = lambda *pairs: [[a / 100, b / 100] for a, b in pairs]
VERS = {
    "G2h": {"big_move": {"open": [[2, 0.5]]}}, "G3h": {"big_move": {"open": [[3, 0.5]]}}, "G3q": {"big_move": {"open": [[3, 0.75]]}},
    "M2q": {"gap_z": [[2, 0.75]]}, "M3q": {"gap_z": [[3, 0.75]]}, "M3a": {"gap_z": [[3, 1.0]]},
    "S2h": {"big_move": {"entry": [[2, 0.5]]}}, "S3h": {"big_move": {"entry": [[3, 0.5]]}},
    "S23": {"big_move": {"entry": [[2, 1 / 3], [3, 2 / 3]]}},
    "L13": {"locks": R_((300, 100), (500, 200), (1000, 400))},
    "L04": {"locks": R_((100, 25), (200, 75), (300, 100), (500, 200), (1000, 400))},
    "L09": {"locks": R_((100, 25), (200, 50), (300, 75), (500, 125), (1000, 250))},
}
NEW = {"BM_open", "BM_entry", "morning_gap_z", "K_lock"}
IDEAS = {i: [f"{k}-c5" for k in VERS if k[0] == i] for i in "GMSL"}
MODES = ("base-c5",) + tuple(f"{k}-c5" for k in VERS)
for v in MODES: SV.SIZEV[v] = SV.SIZEV["t3A-c5"]


def row(t, m, c, rcost, steps):
    _, real = OS.price(steps, c[0], rcost, "bid")
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    held = {}
    for mm in range(m, 390):
        q = RB.quote(c[0], t["date"], mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
    return dict(r1=sim.result(rcost, real, 0.01), r2=sim.result(rcost, real, 0.02), r3=sim.result(rcost, real, 0.03),
                r15=sim.result(rcost, real, 0.015), r05=sim.result(rcost, real, 0.005),
                over=int(any(s[2] == "carry" for s in steps)), h=booked(rcost, real), held=held,
                exit=next((s[5] for s in reversed(real) if s[2] == "sell"), ""), sells=[s for s in real if s[2] == "sell"])


def walk(t, m, c, rcost, over):
    sim.X.clear(); sim.X.update(CHAMP)
    if over: sim.X.update(over)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL, paid=rcost)
    return steps if cost is not None else None


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m = int(t["minute"])
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], float(t["price"]))
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, _ = OS.price(steps, c[0], cost, "bid")
    base = walk(t, m, c, rcost, None)
    if base is None: return None
    rows = {"base-c5": row(t, m, c, rcost, base)}
    for k, over in VERS.items():
        s_ = walk(t, m, c, rcost, over)
        rows[f"{k}-c5"] = row(t, m, c, rcost, s_) if s_ else rows["base-c5"]
    return dict(src=src, kind=kind, date=t["date"], minute=m, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0),
                v=rows, at={v: m for v in rows})


def table(R, adds, part, modes, out, title):
    for size in (0.02, 0.03):
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | **Winners** | Median | Per trade at $10K | End / worst drop | vs 2.10 | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in modes:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(SV.entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                b = out.get(f"{part}|base-c5|{src}|{size}", s)
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | **{s['win']:.1%}** | {s['median']:+,} | {s['per']:+,} | ${s['acct']:,} / {s['dd']:.1%} | {s['acct'] / b['acct']:.3f} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)


def changed(R, part, modes, out):
    """The main legs a lock changed: how many, winners before / after, their sum at $10K before / after, giants cut."""
    print(f"\n#### The trades each lock changed, {part} weeks (main legs at $10K, 1%: 2.10 -> the lock)\n")
    print("| Version | List | Changed | Winners 2.10 -> lock | Sum 2.10 -> lock | Giants (+300%) 2.10 -> lock | Trades with the new sale |")
    print("|---|---|---|---|---|---|---|")
    for v in modes[1:]:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rows = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a]
            ch = [r for r in rows if abs(r["v"][v]["r1"] - r["v"]["base-c5"]["r1"]) > 1e-9]
            b = [max(-1, r["v"]["base-c5"]["r1"]) for r in ch]; l = [max(-1, r["v"][v]["r1"]) for r in ch]
            locked = sum(any(x[5] in NEW for x in r["v"][v]["sells"]) for r in rows)
            g = (sum(x >= 3 for x in b), sum(x >= 3 for x in l))
            out[f"chg|{part}|{v}|{src}"] = dict(n=len(ch), win=(sum(x > 0 for x in b), sum(x > 0 for x in l)),
                                                 sum=(round(1e4 * sum(b)), round(1e4 * sum(l))), giants=g, locked=locked)
            print(f"| {v} | {src} | {len(ch)} | {sum(x > 0 for x in b)} -> {sum(x > 0 for x in l)} | {1e4 * sum(b):+,.0f} -> {1e4 * sum(l):+,.0f} | {g[0]} -> {g[1]} | {locked} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    if os.environ.get("BM_EVERY"): jobs = jobs[::int(os.environ["BM_EVERY"])]  # a quick smoke run
    print(len(jobs), "signals", flush=True)
    with mp.Pool(10) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", MODES, out, "Tune weeks (even)")
    changed(R, "tune", MODES, out)
    k = lambda v, s: out[f"tune|{v}|{s}|0.02"]
    score = lambda v: min(k(v, s)["acct"] / k("base-c5", s)["acct"] for s in ("fair", "fav"))
    picks = [max(vs, key=score) for vs in IDEAS.values()]
    out["picks"] = picks
    for i, p in zip(IDEAS, picks):
        print(f"\n🎯 Idea {i}, picked on tune (min of fair / Favorites vs 2.10 at 2%): {p} ({score(p):.3f})", flush=True)
    table(R, adds, "check", ("base-c5", *picks), out, "Check weeks (odd), the same run")
    changed(R, "check", ("base-c5", *picks), out)
    json.dump(out, open(f"{B}/big_move_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
