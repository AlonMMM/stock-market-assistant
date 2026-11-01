"""Wait for the dip, then buy when the stock turns back up (the user, 2026-11-01, after spike_entry.py: "we do not want
to buy in the pull back - we need to wait for it to come back up", and "yes" to the full test after the examples page
https://claude.ai/artifact/KDSrCkQKpiDQT7YpHK9xnY). spike_entry.py's setup: the champion's entries and picks, 2.9's
exits, the pyramid, real quotes, the walk on the real price paid. A trigger (the 3-minute spike or the 10-minute run, in
S30, the bet's way), then a pullback of 0.25 S30 from the move's extreme within 15 minutes, then the turn: the stock
back up off the dip's low by `res` S30 (or to a new extreme) within 30 minutes -> buy there (the contract picked then).
No pullback: no trade, or ("keep") the signal's own trade. No turn: no trade. Set before running:
  base       2.9
  rs3        3-minute spike >= 1.0, turn 0.25            (the examples page's rule)
  rs3-k      the same, no pullback -> buy at the signal as 2.9
  rs3-50     3-minute spike >= 1.0, turn 0.5
  rs3-hi     3-minute spike >= 1.0, the turn = back to the move's extreme
  rr20       10-minute run >= 2.0, turn 0.25
  rr20-k     the same, no pullback -> buy at the signal
Tune = even entry weeks, check = odd (split.py), in the same run; picked on tune by min(fair, Favorites) vs 2.9.

  node --env-file=.env <dir>/run.mjs resume_entry.py      (from the app repo root)
-> data/local/x/bt/resume_entry_summary.json
"""
import collections, json, math, multiprocessing as mp, os, statistics as st, sys
# 2.9's exits over the champion's (sim.walk lays BT_X over X): the f28 overlay + the break-even lock
os.environ["BT_X"] = json.dumps({"user_stop": {"checks": [], "out": -0.6}, "stock_stages": {"half": 0.5, "full": 1.0},
                                "late_hold": {"from": 330}, "be_lock": {"arm": 0.5, "update": True}})
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
from levels import ctx
from score_sum import account, held as booked
from split import half
from store import calendar

B = "data/local/x/bt"
CAL = calendar()
# name -> (measure, level): "run" = the 10-minute run, "spike" = the 3-minute one
SKIP = {}
# name -> (measure, level, minutes to wait, pullback)
PULL = {}
# name -> (measure, level, the turn off the dip's low in S30 or "hi" = back to the move's extreme, keep the signal's trade when no pullback)
RESUME = {"rs3": ("spike", 1.0, 0.25, False), "rs3-k": ("spike", 1.0, 0.25, True), "rs3-50": ("spike", 1.0, 0.5, False),
          "rs3-hi": ("spike", 1.0, "hi", False), "rr20": ("run", 2.0, 0.25, False), "rr20-k": ("run", 2.0, 0.25, True)}
V = ["base", *RESUME]
SIZES = {0.02: ("r2", "r1"), 0.03: ("r3", "r15"), 0.01: ("r1", "r05")}
BUCKETS = [(-99, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.0), (2.0, 2.5), (2.5, 99)]


def walk_at(t, m, price):
    """The champion's pick and walk from minute m: {r1, r05, r2, r1, r3, r15, over, path} or None."""
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], price)
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    # every exit decided on the real price paid (BT_BASIS=real, the 2.9 audit): walk again from it
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL, paid=rcost)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    row = dict(r1=sim.result(rcost, real, 0.01), r05=sim.result(rcost, real, 0.005), r2=sim.result(rcost, real, 0.02),
               r3=sim.result(rcost, real, 0.03), r15=sim.result(rcost, real, 0.015), over=int(any(s[2] == "carry" for s in steps)),
               h=booked(rcost, real))
    early = [s for s in steps if s[2] == "sell" and s[0] == t["date"] and s[1] <= m + 20]
    sold = sum(s[3] for s in early)
    path = "full at 20"
    if sold >= 0.999: path = "out by 20"
    elif early and all(s[5] == "U_check10" for s in early): path = "half at 10, held at 20"
    elif early: path = "other"
    row["path"] = path
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    row["held"] = {}
    for mm in range(m, 390):
        k = RB.quote(c[0], t["date"], mm)
        row["held"][mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return row


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    bet = 1 if t["right"] == "C" else -1
    cx = ctx(t["sym"], t["date"])
    run = spike = None
    if cx and cx["sd"] and m0 >= 10 and cx["c"][m0] and cx["c"][m0 - 10]:
        run = bet * math.log(cx["c"][m0] / cx["c"][m0 - 10]) / cx["sd"]
    if cx and cx["sd"] and m0 >= 3 and cx["c"][m0] and cx["c"][m0 - 3]:
        spike = bet * math.log(cx["c"][m0] / cx["c"][m0 - 3]) / cx["sd"]
    size = {"run": run, "spike": spike}
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], run=run,
               d2=int(float(t.get("c_t") or 9) < 1.8), v={}, at={})
    base = walk_at(t, m0, float(t["price"]))
    if base is None: return None
    out["v"]["base"] = base; out["at"]["base"] = m0
    if kind == "add":
        for v in V[1:]: out["v"][v] = base; out["at"][v] = m0
        return out
    out["spike"] = spike
    for v, (what, k) in SKIP.items():
        if size[what] is None or size[what] < k: out["v"][v] = base; out["at"][v] = m0
    for v, (what, k, res, keep) in RESUME.items():
        if size[what] is None or size[what] < k: out["v"][v] = base; out["at"][v] = m0; continue
        best, low, mlow = cx["c"][m0], None, None
        for m in range(m0 + 1, min(m0 + 16, 375)):
            px = cx["c"][m]
            if px is None: continue
            best = max(best, px) if bet > 0 else min(best, px)
            if bet * math.log(px / best) <= -0.25 * cx["sd"]: low, mlow = px, m; break
        if mlow is None:
            if keep: out["v"][v] = base; out["at"][v] = m0
            continue
        for m in range(mlow + 1, min(mlow + 31, 375)):
            px = cx["c"][m]
            if px is None: continue
            low = min(low, px) if bet > 0 else max(low, px)
            turned = bet * math.log(px / best) >= 0 if res == "hi" else bet * math.log(px / low) >= res * cx["sd"]
            if turned:
                got = walk_at(t, m, px)
                if got: out["v"][v] = got; out["at"][v] = m
                break
    for v, (what, k, wait, pull) in PULL.items():
        if size[what] is None or size[what] < k: out["v"][v] = base; out["at"][v] = m0; continue
        # the move's extreme since the signal; a pullback of `pull` typical moves from it within `wait` minutes
        best = cx["c"][m0]
        for m in range(m0 + 1, min(m0 + wait + 1, 375)):
            px = cx["c"][m]
            if px is None: continue
            best = max(best, px) if bet > 0 else min(best, px)
            if bet * math.log(px / best) <= -pull * cx["sd"]:
                got = walk_at(t, m, px)
                if got: out["v"][v] = got; out["at"][v] = m
                break
    return out


def entries(R, adds, src, v, part, size, a=""):
    full, halfk = SIZES[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x, m = r["v"][v], r["at"][v]
        E.append((r["date"], m, 1.0, x[full], x["over"], x["h"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or v not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["v"][v][halfk], ad["v"][v]["over"], ad["v"][v]["h"]))
            break
    return E


def stats(E, size):
    R = sorted(E, key=lambda e: e[:5])
    usd = [1e4 * e[2] * max(-1, e[3]) for e in R]
    # booked on the sale day; an add's marks at its half size
    pnl = [dict(date=e[0], pnl=str(u), exit_day=e[5]["exit_day"], marks={d: e[2] * v for d, v in e[5]["marks"].items()})
           for e, u in zip(R, usd)]
    acct, dd = account(pnl, size)
    top = sorted(range(len(R)), key=lambda i: -usd[i])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in set(top[:5])], size)
    giants = {i for i in range(len(R)) if R[i][3] >= 3.0}
    years = collections.defaultdict(float)
    for e, u in zip(R, usd): years[e[0][:4]] += u
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), win=round(sum(e[3] > 0 for e in R) / max(1, len(R)), 3),
                per=round(sum(usd) / max(1, len(R))), median=round(st.median(usd)) if usd else 0,
                nongiant=round(sum(u for i, u in enumerate(usd) if i not in giants)), giants=len(giants),
                best5=round(sum(usd[i] for i in top[:5])), years={y: round(x) for y, x in sorted(years.items())})


def group(rows):
    """Count, giants, median, sum, sum without the giants, by year: main legs at $10K."""
    usd = [1e4 * max(-1, r["v"]["base"]["r1"]) for r in rows]
    g = [u for r, u in zip(rows, usd) if r["v"]["base"]["r1"] >= 3.0]
    years = collections.defaultdict(float)
    for r, u in zip(rows, usd): years[r["date"][:4]] += u
    return dict(n=len(rows), giants=len(g), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)),
                nongiant=round(sum(usd) - sum(g)), years={y: round(x) for y, x in sorted(years.items())})


def table(R, adds, part, out, title):
    for size in SIZES:
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for v in V:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = stats(entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)
    print(f"\n{title}: the trades each version removed or moved (main legs, at $10K: the champion's result on them)\n")
    print("| Version | Fair: trades · their sum · without their giants · giants · median | Favorites: the same |\n|---|---|---|")
    for v in V[1:]:
        cells = []
        for src, a in (("fair", ""), ("fav", FR.A24)):
            hit = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a
                   and (v not in r["v"] or r["at"][v] != r["minute"])]
            g = group(hit); out[f"{part}|{v}|{src}|removed"] = g
            cells.append(f"{g['n']} · {g['sum']:+,} · {g['nongiant']:+,} · {g['giants']} · {g['median']:+,}")
        print(f"| {v} | {cells[0]} | {cells[1]} |", flush=True)


def diagnostics(R, part, out):
    for name, key in (("the first 20 minutes", lambda r: r["v"]["base"]["path"]),
                      ("the run before the signal (typical 30-minute moves)", lambda r: next((f"{a:g} to {b:g}".replace("-99 to", "under").replace(" to 99", " or more")
                                                                                         for a, b in BUCKETS if r["run"] is not None and a <= r["run"] < b), "unknown"))):
        print(f"\n#### Diagnostic, {part} weeks: the champion's trades by {name}\n")
        print("| Group | List | Trades | Giants | Median | Sum | Without the giants | By year |\n|---|---|---|---|---|---|---|---|")
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rows = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a]
            by = collections.defaultdict(list)
            for r in rows: by[key(r)].append(r)
            for k in sorted(by):
                g = group(by[k]); out[f"diag|{part}|{name[:12]}|{src}|{k}"] = g
                yrs = " · ".join(f"{y} {x:+,}" for y, x in g["years"].items())
                print(f"| {k} | {src} | {g['n']} | {g['giants']} | {g['median']:+,} | {g['sum']:+,} | {g['nongiant']:+,} | {yrs} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", out, "Tune weeks (even)")
    base = lambda src: out[f"tune|base|{src}|0.01"]["acct"]
    score = lambda v: min(out[f"tune|{v}|fair|0.01"]["acct"] / base("fair"), out[f"tune|{v}|fav|0.01"]["acct"] / base("fav"))
    best = max(V[1:], key=score)
    out["best"] = best
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs the champion, 1%): {best} ({score(best):.3f}); better on both: {score(best) > 1}")
    table(R, adds, "check", out, "Check weeks (odd), the same run")
    for part in ("tune", "check"): diagnostics(R, part, out)
    json.dump(out, open(f"{B}/resume_entry_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
