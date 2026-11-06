"""Take the profit when SPY turns on a big SPY day (the user, 2026-11-06: "I notice yesterday (very big day in the spy)
that my paper buy a lot in the direction of the fallen, which was a big success. but the bot didn't understand when the
spy start to go back we can take the profits and the stock stopped move in it's own direction"). 2.10's strength exit
reads the stock net of SPY x beta, so it cannot see a turn in SPY itself. Tested before in another form: spy_rules.py B
(2026-10-29, the older champion, any day, part of a winner up +50-200% when SPY fell 0.3-0.5% from its best: slightly
less money). New here: only on a big SPY day, from the minute SPY is 1% or more our way vs yesterday's close (the gap and
pre-market included), any leg in profit, and the stock's stall. Built on 2.10 (size_volume t3A-c5, as big_day.py;
sales at the bid), sim `spy_turn`. Set before running, two ideas, one pick each on tune at 2%: money at least 0.98 of
2.10 on both lists, then the highest win rate; none holding the money -> the most money. The picks run on check:
  S   SPY gives back 0.3% / 0.5% / 0.8% from its extreme our way since the arm: sell 25% / half / all of what is left
  SS  the same, and the stock made no new day extreme our way for 10 minutes
Tune = even weeks, check = odd (split.py), in the same run.

  node --env-file=.env <dir>/run.mjs spy_turn.py      (from the app repo root)
-> data/local/x/bt/spy_turn_summary.json
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
TN = lambda drop, share, stall=0: {"spy_turn": {"big": 0.01, "drop": drop / 100, "share": share, "stall": stall}}
SH_ = {"q": 0.25, "h": 0.5, "a": 1.0}
VERS = {f"{i}{str(dp).replace('.', '')}{sk}": TN(dp, sh, 10 if i == "SS" else 0)
        for i in ("S", "SS") for dp in (0.3, 0.5, 0.8) for sk, sh in SH_.items()}
NEW = {"S_spy_turn"}
IDEAS = {i: [f"{k}-c5" for k in VERS if k.rstrip("qha").rstrip("0123456789") == i] for i in ("S", "SS")}
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
    print(f"\n#### The trades the rule changed, {part} weeks (main legs at $10K, 1%: 2.10 -> the rule)\n")
    print("| Version | List | Changed | Winners 2.10 -> rule | Sum 2.10 -> rule | Giants (+300%) 2.10 -> rule | Trades with the new sale |")
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
    if os.environ.get("TN_EVERY"): jobs = jobs[::int(os.environ["TN_EVERY"])]  # a quick smoke run
    print(len(jobs), "signals", flush=True)
    with mp.Pool(10) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", MODES, out, "Tune weeks (even)")
    changed(R, "tune", MODES, out)
    k = lambda v, s: out[f"tune|{v}|{s}|0.02"]
    # the pick (set before running; the user 2026-11-05: "we are trying to increase also the win rate, because we are going
    # to add more trades ... we have a big variance right now"): money at least 0.98 of 2.10 on both lists, then the
    # highest win rate (the lower of fair / Favorites); if none holds the money, the most money
    money = lambda v: min(k(v, s)["acct"] / k("base-c5", s)["acct"] for s in ("fair", "fav"))
    score = lambda v: (money(v) >= 0.98, min(k(v, s)["win"] for s in ("fair", "fav")) if money(v) >= 0.98 else money(v))
    picks = [max(vs, key=score) for vs in IDEAS.values()]
    out["picks"] = picks
    for i, p in zip(IDEAS, picks):
        print(f"\n🎯 Idea {i}, picked on tune (money >= 0.98 of 2.10 on both lists, then the win rate, 2%): {p} (money {money(p):.3f}, winners {min(k(p, s)['win'] for s in ('fair', 'fav')):.1%})", flush=True)
    table(R, adds, "check", ("base-c5", *picks), out, "Check weeks (odd), the same run")
    changed(R, "check", ("base-c5", *picks), out)
    json.dump(out, open(f"{B}/spy_turn_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
