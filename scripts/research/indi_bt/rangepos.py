"""The range position as an entry filter (the user, 2026-10-30: "go with it", on the test list from Indi's first-15-minute
study: his entries with the stock in the top 20% of its range so far were ~flat without the top 3, those below lost).

pos = where the stock's price at the signal minute sits in the day's range so far (09:30 to that minute, bars up to and
including it), his side: 1 = at the day's high for a call, at the day's low for a put. On the champion's entries, picks
and exits (d2_failed_break.CHAMP, real quotes, the pyramid). Set before running:
  base               the champion
  pos70 / pos80 / pos90       no trade when pos < 0.7 / 0.8 / 0.9 (every entry)
  e-pos70 / e-pos80 / e-pos90  the same, only on entries before 10:00 (minute < 30); later entries as the champion
Two ideas (all entries, early only): one pick each on tune (min of fair and Favorites vs the champion, 2%); only the
picks run on the check weeks. Diagnostic: the champion's trades by pos bucket and by entry time (count, giants, median,
sum, without the giants, by year).
Tune = even entry weeks, check = odd (split.py), in the same run.

  node --env-file=.env <dir>/run.mjs rangepos.py      (from the app repo root)
-> data/local/x/bt/rangepos_summary.json
"""
import collections, json, math, multiprocessing as mp, os, statistics as st, sys
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
LEVELS = {"pos70": (0.7, 390), "pos80": (0.8, 390), "pos90": (0.9, 390),
          "e-pos70": (0.7, 30), "e-pos80": (0.8, 30), "e-pos90": (0.9, 30)}
IDEAS = {"all entries": ["pos70", "pos80", "pos90"], "before 10:00": ["e-pos70", "e-pos80", "e-pos90"]}
V = ["base", *LEVELS]
SIZES = {0.02: ("r2", "r1"), 0.03: ("r3", "r15"), 0.01: ("r1", "r05")}
BUCKETS = [(-1, 0.5), (0.5, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 0.97), (0.97, 2)]


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
    pos = None
    if cx and cx["c"][m0]:
        hs = [x for x in cx["h"][:m0 + 1] if x]; ls = [x for x in cx["l"][:m0 + 1] if x]
        if hs and max(hs) > min(ls):
            pos = (cx["c"][m0] - min(ls)) / (max(hs) - min(ls))
            if bet < 0: pos = 1 - pos
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], run=pos,
               d2=int(float(t.get("c_t") or 9) < 1.8), v={}, at={})
    base = walk_at(t, m0, float(t["price"]))
    if base is None: return None
    out["v"]["base"] = base; out["at"]["base"] = m0
    for v, (k, until) in LEVELS.items():
        if kind == "add" or m0 >= until or pos is None or pos >= k: out["v"][v] = base; out["at"][v] = m0
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


def table(R, adds, part, out, title, VS):
    for size in SIZES:
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for v in VS:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = stats(entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)
    print(f"\n{title}: the trades each version removed or moved (main legs, at $10K: the champion's result on them)\n")
    print("| Version | Fair: trades · their sum · without their giants · giants · median | Favorites: the same |\n|---|---|---|")
    for v in VS[1:]:
        cells = []
        for src, a in (("fair", ""), ("fav", FR.A24)):
            hit = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a
                   and (v not in r["v"] or r["at"][v] != r["minute"])]
            g = group(hit); out[f"{part}|{v}|{src}|removed"] = g
            cells.append(f"{g['n']} · {g['sum']:+,} · {g['nongiant']:+,} · {g['giants']} · {g['median']:+,}")
        print(f"| {v} | {cells[0]} | {cells[1]} |", flush=True)


def diagnostics(R, part, out):
    for name, key in (("the range position at the signal", lambda r: next((f"{a:g} to {b:g}".replace("-1 to", "under").replace(" to 2", " or more")
                                                                    for a, b in BUCKETS if r["run"] is not None and a <= r["run"] < b), "unknown")),
                      ("the range position, entries before 10:00", lambda r: "later" if r["minute"] >= 30 else next((f"before 10:00, {a:g} to {b:g}"
                                                                    for a, b in BUCKETS if r["run"] is not None and a <= r["run"] < b), "unknown"))):
        print(f"\n#### Diagnostic, {part} weeks: the champion's trades by {name}\n")
        print("| Group | List | Trades | Giants | Median | Sum | Without the giants | By year |\n|---|---|---|---|---|---|---|---|")
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rows = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a]
            by = collections.defaultdict(list)
            for r in rows: by[key(r)].append(r)
            for k in sorted(by):
                g = group(by[k]); out[f"diag|{part}|{name[-26:]}|{src}|{k}"] = g
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
    table(R, adds, "tune", out, "Tune weeks (even)", V)
    base = lambda src: out[f"tune|base|{src}|0.02"]["acct"]
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / base("fair"), out[f"tune|{v}|fav|0.02"]["acct"] / base("fav"))
    picks = []
    for idea, vs in IDEAS.items():
        best = max(vs, key=score); picks.append(best)
        print(f"\n🎯 {idea}: picked on tune (min of fair and Favorites vs the champion, 2%): {best} ({score(best):.3f}); better on both: {score(best) > 1}")
    out["picks"] = picks
    table(R, adds, "check", out, "Check weeks (odd), the same run: the champion and the picks", ["base", *picks])
    for part in ("tune", "check"): diagnostics(R, part, out)
    json.dump(out, open(f"{B}/rangepos_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
