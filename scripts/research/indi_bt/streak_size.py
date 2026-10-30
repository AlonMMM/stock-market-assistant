"""Half size after a losing run (the user, 2026-10-30: "checking the drop manage half size after: 1. 5 losers in a row,
10 losers, not big winner for 20 trades, etc").

An overlay on the champion's real-quote trades (refill.py's walk with the champion only: 2.5 + IBIT $0.10 + the pyramid,
opt_spread.price "bid"), the fair list and the Favorites 24 months. Each half (tune = even entry weeks, check = odd) is its
own account from $100,000, a trade costs its size x the account at the start of its day (score_sum.account), its return
recomputed at its size (the 10% overnight cap). A trade's outcome counts only once it has closed before the next entry;
a position (the main leg and its add) is one trade. Set before running:
  base        the champion, flat
  L5 / L10 / L15     after 5 / 10 / 15 losers in a row, half size until a winner
  D20 / D40          no trade of +100% in the last 20 / 40, half size until one
  D20g / D40g        the same with +300% (a giant)
  flat15 / flat175   0.75x / 0.875x the flat size (1.5% / 1.75% at 2%): the yardstick, a rule is worth having only when
                     it beats the flat size with the same worst drop
Picks on tune (min of fair and Favorites vs the champion, 2%): one for the streak rules, one for the drought rules; only
the picks go to the check.

  node --env-file=.env <dir>/run.mjs streak_size.py      (from the app repo root)
-> data/local/x/bt/streak_size_summary.json
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
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
from split import half
from store import calendar

B = "data/local/x/bt"
CAL = calendar()
SIZES = (0.02, 0.03)
FACTORS = (1.0, 0.5, 0.75, 0.875)
LEVELS = sorted({round(s * f * h, 5) for s in SIZES for f in FACTORS for h in (1, 0.5)})   # every size a leg can take
V = {
    "base": ("flat", 1.0),
    "L5": ("streak", 5), "L10": ("streak", 10), "L15": ("streak", 15),
    "D20": ("drought", (20, 1.0)), "D40": ("drought", (40, 1.0)), "D20g": ("drought", (20, 3.0)), "D40g": ("drought", (40, 3.0)),
    "flat15": ("flat", 0.75), "flat175": ("flat", 0.875),
}
IDEAS = {"streak": ["L5", "L10", "L15"], "drought": ["D20", "D40", "D20g", "D40g"]}


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], float(t["price"]))
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], d2=int(float(t.get("c_t") or 9) < 1.8),
               r={lv: sim.result(rcost, real, lv) for lv in LEVELS}, end=max((s[0], s[1]) for s in real))
    if kind == "main":
        sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
        held = {}
        for mm in range(m0, 390):
            k = RB.quote(c[0], t["date"], mm)
            held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
        out["held"] = held
    return out


def positions(R, adds, src, part, a=""):
    """Each position of the champion in one half: its entry, its close, the main leg and the add (when the pyramid buys it)."""
    P = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        add = None
        if r["d2"]:
            for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= r["minute"]: continue
                share, up = r["held"].get(ad["minute"], (0, None))
                if share > 0 and up is not None and up > 0: add = ad
                break
        P.append(dict(date=r["date"], minute=r["minute"], sym=r["sym"], main=r, add=add,
                      end=max([tuple(r["end"])] + ([tuple(add["end"])] if add else []))))
    return sorted(P, key=lambda p: (p["date"], p["minute"]))


def walk(P, size, rule):
    """The account under a rule: (end, worst drop, rows with each position's size factor and $ result)."""
    kind, arg = V[rule]
    eq, cur, start, peak, dd = 1e5, None, 1e5, 1e5, 0.0
    closed, rows = [], []   # (close, return of the main leg at full size) of every position so far
    for p in P:
        if p["date"] != cur:
            cur = p["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        known = [x[1] for x in closed if x[0] < (p["date"], p["minute"])]
        f = 1.0
        if kind == "flat": f = arg
        if kind == "streak":
            run = 0
            for x in reversed(known):
                if x > 0: break
                run += 1
            if run >= arg: f = 0.5
        if kind == "drought":
            n, big = arg
            last = known[-n:]
            if len(last) == n and max(last) < big: f = 0.5
        main = max(-1, p["main"]["r"][round(size * f, 5)])
        usd = start * size * f * main
        if p["add"]: usd += start * size * f / 2 * max(-1, p["add"]["r"][round(size * f / 2, 5)])
        eq += usd
        full = max(-1, p["main"]["r"][size])
        closed.append((p["end"], full))
        rows.append(dict(date=p["date"], sym=p["sym"], f=f, ret=full, usd=usd))
    peak = max(peak, eq)
    return eq, max(dd, 1 - eq / peak), rows


def stats(P, size, rule):
    eq, dd, rows = walk(P, size, rule)
    top = set(sorted(range(len(P)), key=lambda i: -rows[i]["ret"])[:5])
    eq5, _, _ = walk([p for i, p in enumerate(P) if i not in top], size, rule)
    hs = [r for r in rows if r["f"] < 1 and V[rule][0] != "flat"]
    years = collections.defaultdict(float)
    for r in rows: years[r["date"][:4]] += r["usd"]
    return dict(acct=round(eq), dd=round(dd, 3), no5=round(eq5), trades=len(P), half=len(hs),
                half_giants=sum(r["ret"] >= 3 for r in hs), half_sum=round(sum(r["ret"] for r in hs) * 1e4),
                giants=sum(r["ret"] >= 3 for r in rows), median=round(st.median(r["ret"] for r in rows) * 1e4) if rows else 0,
                years={y: round(x) for y, x in sorted(years.items())})


def table(R, adds, part, out, title, rules):
    for size in SIZES:
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Positions | End / worst drop | Without the best 5 | Half-size trades · their giants · their sum at $10K full | Giants | By year (P&L) |")
        print("|---|---|---|---|---|---|---|---|")
        for v in rules:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = stats(positions(R, adds, src, part, a), size, v)
                out[f"{part}|{v}|{src}|{size}"] = s
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | ${s['acct']:,} / {s['dd']:.0%} | ${s['no5']:,} | {s['half']} · {s['half_giants']} · {s['half_sum']:+,} | {s['giants']} | {yrs} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", out, "Tune weeks (even)", list(V))
    base = lambda src: out[f"tune|base|{src}|0.02"]["acct"]
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / base("fair"), out[f"tune|{v}|fav|0.02"]["acct"] / base("fav"))
    picks = {idea: max(vs, key=score) for idea, vs in IDEAS.items()}
    out["picks"] = picks
    for idea, v in picks.items(): print(f"\n🎯 {idea}: {v} ({score(v):.3f} of the champion, min of fair and Favorites, 2%)")
    table(R, adds, "check", out, "Check weeks (odd), the same run", ["base"] + list(picks.values()) + ["flat15", "flat175"])
    json.dump(out, open(f"{B}/streak_size_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
