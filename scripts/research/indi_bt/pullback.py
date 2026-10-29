"""Wait for the pullback after a big move (the user, 2026-10-28, after MU 2026-10-28 bought the top of the opening spike at
09:40 and sold at -32% at 09:47 before the stock came back: "find algorithm that wait for pull back in case we have very
big move in the last 10 minutes ... only for the openning and another test for rest of the day. We need to buy after
the pull back when we see the stock comming back"; then: "in the openning there will be a big move almost always. So
need to normelized it. Also need to see there was no pull back in that 10 minutes ... in the openning wait 20 minutes
... 38% is too much. You cqn use 20% but confirm it coming back go back 25% from the pullback").

On the champion of retry_roll.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes). For each main signal at minute
m0 (the bet's side, b = +1 call / -1 put, stock closes c):
  big     the move m0-10 -> m0, b x (c[m0] / c[m0-10] - 1), >= K x its usual size: the median |10-minute move| over
          the same minutes of the 20 sessions before (time-of-day normalised, so a normal opening swing is not big)
  clean   inside those 10 minutes the stock never gave back more than 20% of the move from its running best
  wait    from m0 on (window W: 20 minutes for an opening signal, m0 = 10; 60 for the rest of the day), the best H keeps
          updating; the pullback is the first close at H - p x (H - c[m0-10]); then from its low L, "coming back" is
          the first close >= L + r x (H - L) with the day's t vs SPY x beta (the bet's side) still > 0.5
  buy     at that minute: the champion's pick (0.15 delta) at that price, walked with the champion's exits
  none    no pullback-and-back inside W: skip the trade ("skip"), or buy at m0 + W if t > 0.5 ("late")
Signals that are not big and clean are bought as the champion buys them. Set before running: K 2 (3 the neighbour),
p 20% (15 / 30%), r 25% (50%), skip and late; the opening (m0 = 10) and the rest of the day (m0 > 10) are two ideas,
each picked on tune by min(fair, Favorites) money. One run, tune AND check (split.py), fair list + Favorites 24m, 2% and
3%. A new entry's contract is picked at its own minute: its fills are on the real book when the cache has that
contract, else the walk's +-2% (the share is printed).

  node --env-file=.env <dir>/run.mjs pullback.py      (from the app repo root)
"""
import collections, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from d2_failed_break import CHAMP
from signals import beta
from split import half
from store import day

B = "data/local/x/bt"
SIZES = rr.SIZES
CLEAN = 0.2
VERS = {}
for part, w in (("open", 20), ("rest", 60)):
    for k, p, r in ((2, 0.2, 0.25), (2, 0.15, 0.25), (2, 0.3, 0.25), (2, 0.2, 0.5), (3, 0.2, 0.25)):
        for none in ("skip", "late"):
            if none == "late" and (k, p, r) != (2, 0.2, 0.25): continue
            VERS[f"{part}-k{k}-p{int(p * 100)}-r{int(r * 100)}-{none}"] = dict(part=part, w=w, k=k, p=p, r=r, none=none)
IDEAS = (("open", tuple(v for v in VERS if v.startswith("open"))), ("rest", tuple(v for v in VERS if v.startswith("rest"))))


def tseries(sym, date, bet):
    """The day's cumulative t vs SPY x beta, on the bet's side, per minute (None before 5 steps)."""
    c = rr.closes(sym, date); spy = rr.closes("SPY", date)
    i = rr.CAL.index(date)
    b_ = beta(sym, date, i, rr.CAL)
    out = [None] * 390
    if b_ is None: return out
    n = s1 = s2 = 0.0
    for m in range(1, 390):
        if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            x = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
            n += 1; s1 += x; s2 += x * x
        if n >= 5:
            var = max(s2 / n - (s1 / n) ** 2, 0.0)
            out[m] = bet * (s1 / n) / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
    return out


def usual_move(sym, date, m0):
    """The median |10-minute move| ending at m0 over the 20 sessions before."""
    i = rr.CAL.index(date)
    xs = []
    for d in rr.CAL[max(0, i - 20):i]:
        c = rr.closes(sym, d)
        if c[m0] and c[m0 - 10]: xs.append(abs(c[m0] / c[m0 - 10] - 1))
    return st.median(xs) if len(xs) >= 10 else None


def entry_minute(c, ts, m0, v):
    """The pullback-and-back minute after a big clean move, or the late minute / None (skip)."""
    base = c[m0 - 10]
    seen = [x for x in c[m0 - 10:m0 + 1] if x]
    best = max(seen) if v["b"] > 0 else min(seen)   # the move's best so far, on the bet's side
    low = None; pulled = False
    for m in range(m0 + 1, min(m0 + v["w"], 374) + 1):
        if not c[m]: continue
        x = c[m]
        if not pulled:
            if (x - best) * v["b"] > 0: best = x
            if (best - x) * v["b"] >= v["p"] * (best - base) * v["b"]: pulled, low = True, x
            continue
        if (low - x) * v["b"] > 0: low = x
        if (x - low) * v["b"] >= v["r"] * (best - low) * v["b"] and ts[m] is not None and ts[m] > 0.5: return m
    if v["none"] == "late":
        m = min(m0 + v["w"], 374)
        if c[m] and ts[m] is not None and ts[m] > 0.5: return m
    return None


def walk(sym, date, m, right, price):
    c = rr.pick(sym, date, m, right, price)
    if not c: return None
    g = rr.leg(sym, date, m, right, c)
    if not g: return None
    rcost, real, book = g
    sells = [s for s in real if s[2] == "sell"]
    held = {}
    for mm in range(m, 390):
        k = RB.quote(c[0], date, mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return dict(r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                over=int(any(s[0] != date for s in sells)), held=held, book=book, minute=m)


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    base = walk(sym, date, m0, right, float(t["price"]))
    if not base: return None
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8), v={"base": base})
    if kind == "add" or m0 < 10: return out
    bet = 1 if right == "C" else -1
    c = rr.closes(sym, date)
    if not c[m0] or not c[m0 - 10]: return out
    mv = bet * (c[m0] / c[m0 - 10] - 1)
    u = usual_move(sym, date, m0)
    if not u or mv <= 0: return out
    run = c[m0 - 10]; worst = 0.0
    for m in range(m0 - 9, m0 + 1):
        if not c[m]: continue
        if (c[m] - run) * bet > 0: run = c[m]
        worst = max(worst, (run - c[m]) * bet)
    total = (max(x for x in c[m0 - 10:m0 + 1] if x) - c[m0 - 10]) if bet > 0 else (c[m0 - 10] - min(x for x in c[m0 - 10:m0 + 1] if x))
    out["big"] = mv / u
    out["clean"] = total > 0 and worst <= CLEAN * total
    if not out["clean"]: return out
    ts = tseries(sym, date, bet)
    part = "open" if m0 == 10 else "rest"
    for name, v in VERS.items():
        if v["part"] != part or mv / u < v["k"]: continue
        m = entry_minute(c, ts, m0, {**v, "b": bet})
        if m is None: out["v"][name] = None; continue
        out["v"][name] = walk(sym, date, m, right, c[m])
    return out


def entries(R, adds, src, v, part, size, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        x = r["v"][v] if v in r["v"] else r["v"]["base"]
        if x is None: continue   # skipped: no pullback and back in the window
        E.append((r["date"], x["minute"], 1.0, x["r"][size], x["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= x["minute"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["v"]["base"]["h"][size], ad["v"]["base"]["over"]))
            break
    return E


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    M = [r for r in R if r["kind"] == "main"]
    for src in ("fair", "fav"):
        for part in ("open", "rest"):
            S = [r for r in M if r["src"] == src and ("big" in r) and ((r["minute"] == 10) == (part == "open"))]
            print(f"{src} {part}: {len(S)} signals measured; big >= 2x usual {sum(r['big'] >= 2 for r in S)}, of them clean {sum(r['big'] >= 2 and r['clean'] for r in S)}; "
                  f">= 3x {sum(r['big'] >= 3 for r in S)}, clean {sum(r['big'] >= 3 and r['clean'] for r in S)}", flush=True)
    L = (("fair", ""), ("fav", FR.A24))
    V = ["base", *VERS]
    out = {(s, p, v): [rr.stats(entries(R, adds, src, v, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in V}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) | Changed tune (fair / fav): later buy / skipped |\n|---|---|---|---|---|---|---|---|")
        for v in V:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            ch = []
            for src, a in L:
                T = [r for r in M if r["src"] == src and half(r["date"]) == "tune" and r["date"] >= a and v in r["v"]]
                ch.append(f"{sum(r['v'][v] is not None for r in T)} / {sum(r['v'][v] is None for r in T)}")
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} | {' · '.join(ch)} |", flush=True)
    for name, group in IDEAS:
        b = out[(0.02, "tune", "base")]
        sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
        best = max(group, key=sc)
        bc, pc = out[(0.02, "check", "base")], out[(0.02, "check", best)]
        print(f"\nPicked on tune ({name}): {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs "
              f"${bc[0]['acct']:,}; Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs "
              f"${bc[0]['no5']:,} / ${bc[1]['no5']:,}", flush=True)
    # the changed trades of the thesis versions, tune, 2%: the champion's buy -> the pullback buy
    for name in ("open-k2-p20-r25-skip", "rest-k2-p20-r25-skip"):
        print(f"\n### {name}: the changed trades (tune, 2%, fair list): date sym side | signal minute -> buy minute | champion -> this")
        for r in sorted((r for r in M if r["src"] == "fair" and half(r["date"]) == "tune" and name in r["v"]), key=lambda r: r["date"]):
            x = r["v"][name]; b = r["v"]["base"]
            got = "skipped" if x is None else f"m{x['minute']} {x['r'][0.02]:+.0%}"
            print(f"  {r['date']} {r['sym']} {r['right']} | m{r['minute']} -> {got} | {b['r'][0.02]:+.0%}", flush=True)
        bk = [r["v"][name]["book"] for r in M if name in r["v"] and r["v"][name]]
        if bk: print(f"  new entries' fills on the real book: {sum(bk) / len(bk):.0%}")
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/pullback_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
