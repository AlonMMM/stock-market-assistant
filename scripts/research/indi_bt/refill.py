"""More checks, and back to full size when the stock is stronger (the user, 2026-10-29: "test on the main bot - way of
exists - add more checks - if we passed the 20minutes check but only with half size - double it if we have stronger
parameters. any way add 30minutes and 60 minutes checks. do a tests with all togeterh and seperates.").

On the champion's entries and picks (2.5 + IBIT down to $0.10 + the pyramid, no cheap fallback), real quotes on the minute
model (opt_spread.price "bid"), the champion's exits (d2_failed_break.CHAMP: -30% stop, the 10 / 20-minute checks, the
rest at -20% after the half, the t-stat exit at 0.5, overnight from +50%). Set before running:
  base      the champion
  rb20      the 10-minute check sold half and the 20-minute check passed (the stock not against): buy the half back at
            the next bar's middle + the fill correction, once (sim.py rebuy "at20"; the 2026-10-24 rebuy.py "A" on today's bot)
  rb20_t    the same, only when the stock's t vs SPY x beta now is at least its t at the entry (stronger)
  rb20_t03  only when it is 0.3 or more above its t at the entry
  rb20_t22  only when it is 2.2 or more
  c30       a 30-minute check: the stock against the entry sells what is left
  c60       a 60-minute check, the same
  c3060     both
  all       rb20_t + c3060
Each variant's pyramid reads its own first leg. Tune = even entry weeks, check = odd weeks (split.py), in the same run;
the fair list and the Favorites 24 months; 1%, 2% and 3% of the account, the 10% overnight cap at each size.

  node --env-file=.env <dir>/run.mjs refill.py      (from the app repo root)
-> data/local/x/bt/refill_summary.json
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
from score_sum import account
from split import half
from store import calendar

B = "data/local/x/bt"
CAL = calendar()
CHECKS = CHAMP["user_stop"]["checks"]
US = lambda extra: {"user_stop": {**CHAMP["user_stop"], "checks": CHECKS + extra}}
RB20 = {"mode": "at20", "until": 330}
V = {
    "base": {},
    "rb20": {"rebuy": RB20},
    "rb20_t": {"rebuy": {**RB20, "t_over": 0.0}},
    "rb20_t03": {"rebuy": {**RB20, "t_over": 0.3}},
    "rb20_t22": {"rebuy": {**RB20, "min_t": 2.2}},
    "c30": US([[30, 1.0]]),
    "c60": US([[60, 1.0]]),
    "c3060": US([[30, 1.0], [60, 1.0]]),
    "all": {"rebuy": {**RB20, "t_over": 0.0}, **US([[30, 1.0], [60, 1.0]])},
}
SIZES = {0.01: ("r1", "r05"), 0.02: ("r2", "r1"), 0.03: ("r3", "r15")}   # size: (a full trade, the half-size add)


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
        row = dict(r1=sim.result(rcost, real, 0.01), r05=sim.result(rcost, real, 0.005), r2=sim.result(rcost, real, 0.02),
                   r3=sim.result(rcost, real, 0.03), r15=sim.result(rcost, real, 0.015), over=int(any(s[2] == "carry" for s in steps)),
                   rebuy=int(any(s[5] == "rebuy" for s in steps)), rules=sorted({s[5] for s in steps if s[2] == "sell"}))
        if kind == "main":
            sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
            held = {}
            for mm in range(m0, 390):
                k = RB.quote(c[0], t["date"], mm)
                held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
            row["held"] = held
        out["v"][name] = row
    return out


def entries(R, adds, src, v, part, size, a=""):
    """(date, minute, weight, return, overnight, key) of every trade of variant v: the main legs and the pyramid adds."""
    full, halfk = SIZES[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x = r["v"][v]
        E.append((r["date"], r["minute"], 1.0, x[full], x["over"], (r["date"], r["sym"], r["right"], "main")))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"] or v not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0:
                E.append((ad["date"], ad["minute"], 0.5, ad["v"][v][halfk], ad["v"][v]["over"], (r["date"], r["sym"], r["right"], "add")))
            break
    return E


def stats(E, size):
    R = sorted(E)
    usd = [1e4 * e[2] * max(-1, e[3]) for e in R]   # each trade at $10K (an add at $5K)
    pnl = [dict(date=e[0], pnl=str(u)) for e, u in zip(R, usd)]
    acct, dd = account(pnl, size)
    top = sorted(range(len(R)), key=lambda i: -usd[i])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in set(top[:5])], size)
    giants = [i for i in range(len(R)) if R[i][3] >= 3.0]   # +300% or more (giants-decide-buckets)
    years = collections.defaultdict(float)
    for e, u in zip(R, usd): years[e[0][:4]] += u
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), win=round(sum(e[3] > 0 for e in R) / max(1, len(R)), 3),
                per=round(sum(usd) / max(1, len(R))), median=round(st.median(usd)) if usd else 0,
                nongiant=round(sum(u for i, u in enumerate(usd) if i not in set(giants))), giants=len(giants),
                best5=round(sum(usd[i] for i in top[:5])), years={y: round(v) for y, v in sorted(years.items())})


def changed(R, v, part):
    """The main legs whose result differs from the champion's: count, sum at $10K, sum without their best 5."""
    d = [1e4 * (max(-1, r["v"][v]["r1"]) - max(-1, r["v"]["base"]["r1"])) for r in R
         if r["kind"] == "main" and half(r["date"]) == part and v in r["v"] and "base" in r["v"] and abs(r["v"][v]["r1"] - r["v"]["base"]["r1"]) > 1e-6]
    d.sort(reverse=True)
    reb = sum(1 for r in R if r["kind"] == "main" and half(r["date"]) == part and v in r["v"] and r["v"][v]["rebuy"])
    return dict(n=len(d), sum=round(sum(d)), no5=round(sum(d[5:])), rebuys=reb)


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
    print(f"\n{title}: trades changed vs the champion (main legs, at $10K)\n")
    print("| Version | Fair: changed · sum · without their best 5 · refills | Favorites: the same |\n|---|---|---|")
    for v in list(V)[1:]:
        f = changed([r for r in R if r["src"] == "fair"], v, part)
        g = changed([r for r in R if r["src"] == "fav" and r["date"] >= FR.A24], v, part)
        out[f"{part}|{v}|changed"] = dict(fair=f, fav=g)
        print(f"| {v} | {f['n']} · {f['sum']:+,} · {f['no5']:+,} · {f['rebuys']} | {g['n']} · {g['sum']:+,} · {g['no5']:+,} · {g['rebuys']} |", flush=True)


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
    best = max(list(V)[1:], key=score)
    out["best"] = best
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs the champion, 1%): {best} ({score(best):.3f}); better on both: {score(best) > 1}")
    table(R, adds, "check", out, "Check weeks (odd), the same run")
    json.dump(out, open(f"{B}/refill_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
