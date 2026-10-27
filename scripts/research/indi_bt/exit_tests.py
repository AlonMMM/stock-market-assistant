"""Cutting the losers (the user, 2026-10-27: "lets take care of the huge drops ... improve our exits - strategy and cut
the big losers"; "Yes to all" to: a stop at the entry price once up, a tighter first stop, holding overnight from a
lower gain). On the champion's entries and picks (2.5 + IBIT down to $0.10 + the pyramid, no cheap fallback), real
quotes on the minute model (opt_spread.price "bid"; the stops fire after the 1-second book's window). Set before
running, each on the champion's exits (d2_failed_break.CHAMP):
  base       the champion: the -30% stop, the 10 / 20-minute checks, the rest at -20% after the half, the t-stat exit,
             overnight from +50%
  be30 / be30p10   once the option was up 30% on the entry day, all out when it falls back to cost / to +10%
                   (sim.py guard, day0: the overnight hold untouched)
  be50 / be50p10   the same once up 50%
  stop20 / stop25  the first stop at -20% / -25% (was -30%)
  hold25 / hold35  overnight from +25% / +35% (was +50%)
Each variant's pyramid reads its own first leg (held and up at the add's minute on the real mid). Picked on the tune
weeks (split.py), one run on the check weeks; the fair list and the Favorites 24 months.

  node --env-file=.env <dir>/run.mjs exit_tests.py      (from the app repo root)
-> data/local/x/bt/exit_tests_summary.json
"""
import collections, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from score_sum import account
from split import half
from store import calendar

B = "data/local/x/bt"
CAL = calendar()
V = {
    "base": {},
    # the stock's own move (the user, 2026-10-27: "exit by the moving of the stock too ... the support and resistance
    # approach to stop. Also big move against - more than a correction might be an exit even if we are winning"); run
    # with EXIT_RUN=stock
    "lvl0": {"level_stop": {"buffer": 0.0}},
    "lvl25": {"level_stop": {"buffer": 0.25}},
    "lvl50": {"level_stop": {"buffer": 0.5}},
    "lvl2nd25": {"level_stop": {"buffer": 0.25, "nth": 2}},
    "trail25": {"stock_trail": {"k": 2.5}},
    "trail30": {"stock_trail": {"k": 3.0}},
    # overnight only for bigger winners (the user, 2026-10-27: "What if we go overnight only if bigger than 100% 200%
    # 150%?"); run with EXIT_RUN=hold
    "hold100": {"carry_min_gain": 1.0},
    "hold150": {"carry_min_gain": 1.5},
    "hold200": {"carry_min_gain": 2.0},
    # around +50% (the user: "Can you show me the overnight for 25 75 60 40?"); EXIT_RUN=hold2
    "hold40": {"carry_min_gain": 0.4},
    "hold60": {"carry_min_gain": 0.6},
    "hold75": {"carry_min_gain": 0.75},
    # protect the huge winners (the user, 2026-10-27: "when we hit 1000% gain we start a stop of 30% of the trade ... another
    # test for moving the stock - only those that have more than 1000% gain. do the same for 1500% and 2000%"); EXIT_RUN=big
    "opt1000": {"guard": {"arm": 10.0, "trail": 0.3}},
    "opt1500": {"guard": {"arm": 15.0, "trail": 0.3}},
    "opt2000": {"guard": {"arm": 20.0, "trail": 0.3}},
    "stk1000": {"big_trail": {"arm": 10.0, "k": 1.0}},
    "stk1500": {"big_trail": {"arm": 15.0, "k": 1.0}},
    "stk2000": {"big_trail": {"arm": 20.0, "k": 1.0}},
    # a looser give-back for the giants, and a looser loss stop (the user, 2026-10-27: "if I put 45% stop?"); EXIT_RUN=big45
    "opt1000t45": {"guard": {"arm": 10.0, "trail": 0.45}},
    "opt1500t45": {"guard": {"arm": 15.0, "trail": 0.45}},
    "opt2000t45": {"guard": {"arm": 20.0, "trail": 0.45}},
    "stop45": {"user_stop": {**CHAMP["user_stop"], "out": -0.45}},
    "be30": {"guard": {"arm": 0.3, "floor": 0.0, "day0": True}},
    "be30p10": {"guard": {"arm": 0.3, "floor": 0.1, "day0": True}},
    "be50": {"guard": {"arm": 0.5, "floor": 0.0, "day0": True}},
    "be50p10": {"guard": {"arm": 0.5, "floor": 0.1, "day0": True}},
    "stop20": {"user_stop": {**CHAMP["user_stop"], "out": -0.2}},
    "stop25": {"user_stop": {**CHAMP["user_stop"], "out": -0.25}},
    "hold25": {"carry_min_gain": 0.25},
    "hold35": {"carry_min_gain": 0.35},
}
STOCK = ("base", "lvl0", "lvl25", "lvl50", "lvl2nd25", "trail25", "trail30")
HOLD = ("base", "hold100", "hold150", "hold200")
RUN = os.environ.get("EXIT_RUN")
if RUN == "stock": V = {k: v for k, v in V.items() if k in STOCK}
elif RUN == "hold": V = {k: v for k, v in V.items() if k in HOLD}
elif RUN == "hold2": V = {k: v for k, v in V.items() if k in ("base", "hold25", "hold40", "hold60", "hold75")}
elif RUN == "big": V = {k: v for k, v in V.items() if k == "base" or (k.startswith(("opt", "stk")) and not k.endswith("t45"))}
elif RUN == "big45": V = {k: v for k, v in V.items() if k in ("base", "opt1000", "opt1000t45", "opt1500t45", "opt2000t45", "stop45")}
else: V = {k: v for k, v in V.items() if (k not in STOCK and k not in HOLD and k not in ("hold40", "hold60", "hold75", "stop45") and not k.startswith(("opt", "stk"))) or k == "base"}


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], float(t["price"]))
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], d2=int(float(t.get("c_t") or 9) < 1.8), v={})
    for name, over in V.items():
        sim.X.clear(); sim.X.update({**CHAMP, **over})
        cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], c[0], c[1], CAL)
        if cost is None: continue
        rcost, real = OS.price(steps, c[0], cost, "bid")
        # each size with the overnight cap at that size; an add is half a trade at half the size (2%: 1%, 3%: 1.5%)
        row = dict(r1=sim.result(rcost, real, 0.01), r05=sim.result(rcost, real, 0.005), r2=sim.result(rcost, real, 0.02),
                   r3=sim.result(rcost, real, 0.03), r15=sim.result(rcost, real, 0.015), over=int(any(s[2] == "carry" for s in steps)))
        if kind == "main":
            sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
            held = {}
            for mm in range(m0, 390):
                k = RB.quote(c[0], t["date"], mm)
                held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
            row["held"] = held
        out["v"][name] = row
    return out


SIZE = float(os.environ.get("EXIT_SIZE", "0.01"))   # 0.02 / 0.03: the returns at that size (the user: "show it on 2 and 3%")
FULL = {0.01: "r1", 0.02: "r2", 0.03: "r3"}[SIZE]
HALF = {0.01: "r05", 0.02: "r1", 0.03: "r15"}[SIZE]


def entries(R, adds, src, v, part, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x = r["v"][v]
        E.append((r["date"], r["minute"], 1.0, x[FULL], x["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"] or v not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["v"][v][HALF], ad["v"][v]["over"]))
            break
    return E


def stats(E):
    R = sorted(E)
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[3]))) for e in R]
    acct, dd = account(pnl, SIZE)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], SIZE)
    same = [e for e in R if not e[4]]
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), win=round(sum(e[3] > 0 for e in R) / max(1, len(R)), 3),
                sameday=round(sum(1e4 * e[2] * max(-1, e[3]) for e in same)), overnight=sum(1 for e in R if e[4]))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    print(f"\n### Tune weeks, real quotes, {SIZE:.0%} from $100,000\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) | Winners (fair) | Same-day P&L at $10K (fair) | Overnight trades (fair) |\n|---|---|---|---|---|---|---|")
    for v in V:
        f, g = stats(entries(R, adds, "fair", v, "tune")), stats(entries(R, adds, "fav", v, "tune", FR.A24))
        changed = {src: sum(1 for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == "tune" and v in r["v"] and "base" in r["v"]
                            and abs(r["v"][v][FULL] - r["v"]["base"][FULL]) > 1e-6) for src in ("fair", "fav")}
        if v != "base": print(f"  ({v}: {changed['fair']} fair / {changed['fav']} Favorites trades changed)", flush=True)
        out[f"tune|{v}"] = dict(fair=f, fav=g, changed=changed)
        print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} | {f['win']:.0%} | {f['sameday']:+,} | {f['overnight']} |", flush=True)
    base = out["tune|base"]
    score = lambda v: min(out[f"tune|{v}"]["fair"]["acct"] / base["fair"]["acct"], out[f"tune|{v}"]["fav"]["acct"] / base["fav"]["acct"])
    best = max(list(V)[1:], key=score)
    print(f"\nPicked on tune: {best}; better than the champion on both tune lists: {score(best) > 1}\n")
    out["best"] = best
    if os.environ.get("EXIT_NO_CHECK"):
        json.dump(out, open(f"{B}/exit_tests_summary_{os.environ.get('EXIT_RUN', 'loss')}_{SIZE}.json", "w"), indent=1)
        return
    print("### Check weeks, one run\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) |\n|---|---|---|---|")
    for v in ("base", best):
        f, g = stats(entries(R, adds, "fair", v, "check")), stats(entries(R, adds, "fav", v, "check", FR.A24))
        out[f"check|{v}"] = dict(fair=f, fav=g)
        print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} |", flush=True)
    out["best"] = best
    json.dump(out, open(f"{B}/exit_tests_summary_{os.environ.get('EXIT_RUN', 'loss')}_{SIZE}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
