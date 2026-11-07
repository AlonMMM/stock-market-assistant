"""A small entry adds up to a full size (the user, 2026-11-07: "I want the add quater to be add for a full size in case
we are using small size. we also do not need to add to more tha 2X"). On d of add_balance.py (2.10 + a 25% confirmation
add once the stock is +1.0 S30 our way within 10 minutes, + S03h, the SPY-turn half sale). Set before running:
  d    add_balance d: the add is 25% of the first leg for every size
  e    d, but a small entry (the 0.5 tier, volume ratio under 1.75) adds 100% of its first leg (0.5 -> 1.0, a full
       size); the others still add 25%; never more than 2x the first leg: after a 100% add the D2 pyramid add is skipped
  en   e without the 2x line (the pyramid add may still come on top: up to 2.5x), to see what the line does
  f    e without S03h
Read against 2.10, 2.12 and d: money, winners, worst drop. Tune = even weeks, check = odd (split.py), in the same run,
then all weeks in one account (tune and check joined).

  node --env-file=.env <dir>/run.mjs add_small.py      (from the app repo root)
-> data/local/x/bt/add_small_summary.json
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
S03H = {"spy_turn": {"big": 0.01, "drop": 0.003, "share": 0.5, "stall": 0}}
L04 = {"locks": [[a / 100, b / 100] for a, b in ((100, 25), (200, 75), (300, 100), (500, 200), (1000, 400))]}
# name -> (add share of the first leg, extra exits)
VERS = {"c212": (0.5, {}), "d": (0.25, S03H), "e": ("small", S03H), "en": ("small", S03H), "f": ("small", {})}
X2 = {"e-c5", "f-c5"}   # never more than 2x the first leg
IDEAS = {"e": ["e-c5", "en-c5"], "f": ["f-c5"]}
MODES = ("base-c5",) + tuple(f"{k}-c5" for k in VERS)
for v in MODES: SV.SIZEV[v] = SV.SIZEV["t3A-c5"]


def share_for(k, rvol):
    share, _ = VERS[k]
    if share != "small": return share
    small = SV.SIZEV["t3A-c5"](rvol) < 1.0
    return 1.0 if small else 0.25


def over_for(k, kind, rvol):
    _, extra = VERS[k]
    share = share_for(k, rvol)
    return {"stock_stages": {"add": {"within": 10, "move": 1.0, "share": share}}, **extra}


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
                exit=next((s[5] for s in reversed(real) if s[2] == "sell"), ""), sells=[s for s in real if s[2] == "sell"],
                added=int(any(s[2] == "buy" and s[5] == "rebuy" for s in real)))


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
    for k in VERS:
        s_ = walk(t, m, c, rcost, over_for(k, kind, float(t.get("c_rvol") or 0)))
        rows[f"{k}-c5"] = row(t, m, c, rcost, s_) if s_ else rows["base-c5"]
        rows[f"{k}-c5"] = {**rows[f"{k}-c5"], "share": share_for(k, float(t.get("c_rvol") or 0))}
    return dict(src=src, kind=kind, date=t["date"], minute=m, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0),
                v=rows, at={v: m for v in rows})


def entries(R, adds, src, v, part, size, a=""):
    """size_volume.entries, with the 2x line (X2) and part "all" = every week."""
    full, halfk = SV.SIZES[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or r["date"] < a or v not in r["v"]: continue
        if part != "all" and half(r["date"]) != part: continue
        x, m = r["v"][v], r["at"][v]
        w = SV.SIZEV[v](r.get("rvol", 0))
        E.append((r["date"], m, w, x[full], x["over"], x["h"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or v not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            aw = min(0.5 * w, max(0.0, 0.05 / size - w))   # the position within 5% of the account
            if v in X2 and x.get("added"): aw = min(aw, max(0.0, w * (1 - x.get("share", 0))))
            if share > 0 and up is not None and up > 0 and aw > 1e-9: E.append((ad["date"], ad["minute"], aw, ad["v"][v][halfk], ad["v"][v]["over"], ad["v"][v]["h"]))
            break
    return E


def table(R, adds, part, modes, out, title):
    for size in (0.02, 0.03):
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | **Winners** | Median | Per trade at $10K | End / worst drop | vs 2.10 | vs 2.12 | vs d | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in modes:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                b = out.get(f"{part}|base-c5|{src}|{size}", s); b2 = out.get(f"{part}|c212-c5|{src}|{size}", s); b3 = out.get(f"{part}|d-c5|{src}|{size}", s)
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | **{s['win']:.1%}** | {s['median']:+,} | {s['per']:+,} | ${s['acct']:,} / {s['dd']:.1%} | {s['acct'] / b['acct']:.3f} | {s['acct'] / b2['acct']:.3f} | {s['acct'] / b3['acct']:.3f} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)


def changed(R, part, modes, out):
    """The main legs a lock changed: how many, winners before / after, their sum at $10K before / after, giants cut."""
    print(f"\n#### The trades the rule changed, {part} weeks (main legs at $10K, 1%: 2.10 -> the rule)\n")
    print("| Version | List | Changed | Winners 2.10 -> rule | Median 2.10 -> rule | Sum 2.10 -> rule | Non-giant sum 2.10 -> rule | Giants (+300%) 2.10 -> rule | Trades with an add |")
    print("|---|---|---|---|---|---|---|---|---|")
    for v in modes[1:]:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rows = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a]
            ch = [r for r in rows if abs(r["v"][v]["r1"] - r["v"]["base-c5"]["r1"]) > 1e-9]
            b = [max(-1, r["v"]["base-c5"]["r1"]) for r in ch]; l = [max(-1, r["v"][v]["r1"]) for r in ch]
            locked = sum(r["v"][v].get("added", 0) for r in rows)
            g = (sum(x >= 3 for x in b), sum(x >= 3 for x in l))
            gb = [x for x, y in zip(b, l) if x < 3 and y < 3]; gl = [y for x, y in zip(b, l) if x < 3 and y < 3]
            md = (round(1e4 * st.median(b)) if b else 0, round(1e4 * st.median(l)) if l else 0)
            ng = (round(1e4 * sum(gb)), round(1e4 * sum(gl)))
            out[f"chg|{part}|{v}|{src}"] = dict(n=len(ch), win=(sum(x > 0 for x in b), sum(x > 0 for x in l)), median=md, nongiant=ng,
                                                 sum=(round(1e4 * sum(b)), round(1e4 * sum(l))), giants=g, added=locked)
            print(f"| {v} | {src} | {len(ch)} | {sum(x > 0 for x in b)} -> {sum(x > 0 for x in l)} | {md[0]:+,} -> {md[1]:+,} | {1e4 * sum(b):+,.0f} -> {1e4 * sum(l):+,.0f} | {ng[0]:+,} -> {ng[1]:+,} | {g[0]} -> {g[1]} | {locked} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    if os.environ.get("ST_EVERY"): jobs = jobs[::int(os.environ["ST_EVERY"])]  # a quick smoke run
    print(len(jobs), "signals", flush=True)
    with mp.Pool(10) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", MODES, out, "Tune weeks (even)")
    changed(R, "tune", MODES, out)
    k = lambda v, s: out[f"tune|{v}|{s}|0.02"]
    # the pick (set before running): the most money, the lower of fair / Favorites vs 2.10 at 2%
    money = lambda v: min(k(v, s)["acct"] / k("base-c5", s)["acct"] for s in ("fair", "fav"))
    score = money
    picks = [max(vs, key=score) for vs in IDEAS.values()]
    out["picks"] = picks
    for i, p in zip(IDEAS, picks):
        print(f"\n🎯 Idea {i}, picked on tune (the most money, min of both lists vs 2.10, 2%): {p} (money {money(p):.3f}, winners {min(k(p, s)['win'] for s in ('fair', 'fav')):.1%})", flush=True)
    table(R, adds, "check", ("base-c5", "c212-c5", "d-c5", *picks), out, "Check weeks (odd), the same run")
    changed(R, "check", ("base-c5", "c212-c5", "d-c5", *picks), out)
    table(R, adds, "all", MODES, out, "All weeks in one account (tune and check joined)")
    json.dump(out, open(f"{B}/add_small_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
