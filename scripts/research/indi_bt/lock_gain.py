"""Lock a gain (the user, 2026-11-04: "test another strategy of exit of lock gain ... like today, the lock break even,
let's try a lock gain. If the stock go up more than 300%, then we're locking a 100% or 50%. If it go 100%, let locks 35%,
and so on. Try like 10 or 15 rules ... It's not had to beat the gain, but I would like it to reduce the drop and increase
the win rate. Increasing the win rate is very important for me."). Built on 2.10 (size_volume t3A-c5: its entries,
picks, exits incl. the break-even lock, sizing and pyramid; exits decided on the real price paid; sales at the bid).
Each version adds sim.py `locks` [[reached, lock], ...]: once the option's best mark (the real book mid, every stock
minute, any day held) has been up `reached` over what was paid, all out when it falls back to the highest such rung's
`lock` (sold at the next book's bid, so a gap through the lock sells lower). Set before running (reached -> lock):
  L01  100 -> 35, 300 -> 100                         (the user's)
  L02  100 -> 35, 300 -> 50                          (the user's other 300 lock)
  L03  50 -> 10, 100 -> 35, 200 -> 75, 300 -> 100, 500 -> 200
  L04  100 -> 25, 200 -> 75, 300 -> 100, 500 -> 200, 1000 -> 400
  L05  100 -> 50, 300 -> 150
  L06  75 -> 25, 150 -> 60, 300 -> 120, 600 -> 250
  L07  a third of the best from +100%: 100 -> 33, 200 -> 67, 300 -> 100, 500 -> 167, 1000 -> 333
  L08  half of the best from +100%:    100 -> 50, 200 -> 100, 300 -> 150, 500 -> 250, 1000 -> 500
  L09  a quarter of the best from +100%: 100 -> 25, 200 -> 50, 300 -> 75, 500 -> 125, 1000 -> 250
  L10  small gains kept: 30 -> 5, 50 -> 15, 100 -> 35, 300 -> 100
  L11  smaller still: 20 -> 3, 40 -> 10, 60 -> 20, 100 -> 35, 300 -> 100
  L12  tight: 50 -> 20, 100 -> 50, 200 -> 100, 300 -> 150, 500 -> 250
  L13  only the big ones: 300 -> 100, 500 -> 200, 1000 -> 400
  L14  100 -> 35 only
  L15  200 -> 75, 300 -> 100
Pick on tune (the user's goal, set before running): among the versions whose worst drop at 2% is at or under 2.10's on
both lists, the highest win rate (the lower of fair and Favorites); a tie: more money. Only the pick runs on check,
in the same run. Tune = even weeks, check = odd (split.py).

  node --env-file=.env <dir>/run.mjs lock_gain.py      (from the app repo root)
-> data/local/x/bt/lock_gain_summary.json
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
LOCKS = {
    "L01": R_((100, 35), (300, 100)),
    "L02": R_((100, 35), (300, 50)),
    "L03": R_((50, 10), (100, 35), (200, 75), (300, 100), (500, 200)),
    "L04": R_((100, 25), (200, 75), (300, 100), (500, 200), (1000, 400)),
    "L05": R_((100, 50), (300, 150)),
    "L06": R_((75, 25), (150, 60), (300, 120), (600, 250)),
    "L07": R_((100, 33), (200, 67), (300, 100), (500, 167), (1000, 333)),
    "L08": R_((100, 50), (200, 100), (300, 150), (500, 250), (1000, 500)),
    "L09": R_((100, 25), (200, 50), (300, 75), (500, 125), (1000, 250)),
    "L10": R_((30, 5), (50, 15), (100, 35), (300, 100)),
    "L11": R_((20, 3), (40, 10), (60, 20), (100, 35), (300, 100)),
    "L12": R_((50, 20), (100, 50), (200, 100), (300, 150), (500, 250)),
    "L13": R_((300, 100), (500, 200), (1000, 400)),
    "L14": R_((100, 35)),
    "L15": R_((200, 75), (300, 100)),
}
MODES = ("base-c5",) + tuple(f"{k}-c5" for k in LOCKS)
for v in MODES: SV.SIZEV[v] = SV.SIZEV["t3A-c5"]
PROBE = min(r[0][0] for r in LOCKS.values())


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
                exit=next((s[5] for s in reversed(real) if s[2] == "sell"), ""))


def walk(t, m, c, rcost, locks):
    sim.X.clear(); sim.X.update(CHAMP)
    if locks: sim.X["locks"] = locks
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
    # a lock only adds exits: a trade never up PROBE over what was paid is 2.10's in every version
    probe = walk(t, m, c, rcost, [[PROBE, 100.0]])
    reached = bool(probe) and any(s[2] == "sell" and s[5] == "K_lock" for s in probe)
    for k, locks in LOCKS.items():
        s_ = walk(t, m, c, rcost, locks) if reached else None
        rows[f"{k}-c5"] = row(t, m, c, rcost, s_) if s_ else rows["base-c5"]
    return dict(src=src, kind=kind, date=t["date"], minute=m, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), reached=reached,
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
    print("| Version | List | Changed | Winners 2.10 -> lock | Sum 2.10 -> lock | Giants (+300%) 2.10 -> lock | Locked exits |")
    print("|---|---|---|---|---|---|---|")
    for v in modes[1:]:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rows = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a]
            ch = [r for r in rows if abs(r["v"][v]["r1"] - r["v"]["base-c5"]["r1"]) > 1e-9]
            b = [max(-1, r["v"]["base-c5"]["r1"]) for r in ch]; l = [max(-1, r["v"][v]["r1"]) for r in ch]
            locked = sum(r["v"][v]["exit"] == "K_lock" for r in rows)
            g = (sum(x >= 3 for x in b), sum(x >= 3 for x in l))
            out[f"chg|{part}|{v}|{src}"] = dict(n=len(ch), win=(sum(x > 0 for x in b), sum(x > 0 for x in l)),
                                                 sum=(round(1e4 * sum(b)), round(1e4 * sum(l))), giants=g, locked=locked)
            print(f"| {v} | {src} | {len(ch)} | {sum(x > 0 for x in b)} -> {sum(x > 0 for x in l)} | {1e4 * sum(b):+,.0f} -> {1e4 * sum(l):+,.0f} | {g[0]} -> {g[1]} | {locked} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(10) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    print(f"{sum(r['reached'] for r in R)} of {len(R)} legs were up +{PROBE:.0%} at some point", flush=True)
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", MODES, out, "Tune weeks (even)")
    changed(R, "tune", MODES, out)
    k = lambda v, s: out[f"tune|{v}|{s}|0.02"]
    ok = lambda v: all(k(v, s)["dd"] <= k("base-c5", s)["dd"] + 1e-9 for s in ("fair", "fav"))
    score = lambda v: (ok(v), min(k(v, s)["win"] for s in ("fair", "fav")), min(k(v, s)["acct"] / k("base-c5", s)["acct"] for s in ("fair", "fav")))
    best = max(MODES[1:], key=score)
    out["best"] = best
    print(f"\n🎯 Picked on tune (worst drop at or under 2.10 on both lists, then the highest win rate, 2%): {best} "
          f"(drop rule met: {ok(best)}; winners {min(k(best, s)['win'] for s in ('fair', 'fav')):.1%} vs "
          f"{min(k('base-c5', s)['win'] for s in ('fair', 'fav')):.1%})", flush=True)
    table(R, adds, "check", ("base-c5", best), out, "Check weeks (odd), the same run")
    changed(R, "check", ("base-c5", best), out)
    json.dump(out, open(f"{B}/lock_gain_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
