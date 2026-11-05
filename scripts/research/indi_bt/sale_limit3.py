"""Sell above the bid, look 3 (2026-11-05): the 2.11 release audit found `sale_limit.py:94` booking the decision minute's
bid when a later step reached the bid (1-4 minutes stale), and that the rest of the gain needs fills a small print
"proves". The user: "go" (fix it, a size-aware fill proof, and his idea: "what about going with the real last trade
price if its in the last 5 sec?"); then "approve the 9 minutes" (Databento OPRA trades with sizes, minute m-2 .. m+7
around every 2.10 sale: dbx_cache/trades911, bought by the session's trades_fetch.py).

Built on 2.10 (size_volume.py t3A-c5), only the sale price changes, as sale_limit.py. What changes against look 2:
  - a step whose limit is at or under the bid THEN sells at that bid (the book at the end of the minute before it);
  - a limit fills only by real prints at or above it inside its own minute, after it is posted, up to their summed size
    (partial fills carry the rest to the next step), or in full when the bid at the minute's end comes up to it;
  - our contracts = STAKE x 2.10's volume size (0.5 / 1 / 1.5) / (paid x 100) x the sale's share; STAKE $5,000 (the
    verdict) and $10,000 (shown), set before running; whatever is left at the window's end sells at the bid then.
Versions, all set before running (one pick an idea on tune by min(fair, Favorites) vs 2.10 at 2%, on the $5K proof):
  bid           2.10: the bid at once
  A  M1 M3 M5   from the mid, stepped down evenly to the bid over N minutes (look 2's M family, fixed)
  B  L1 L3 L5   the same from the higher of the mid and the last print in the 5 seconds before the decision (the
                book at the end of minute m - 1), capped at the ask - 1 cent
  C  G3w10 G3w20 G5w10   M3 / M3 / M5 on the morning-gap sales only (09:40 rule, kept or against) when the spread is
                >= 10% / 20% of the mid; every other sale at the bid
Each with the suffix k5 / k10 = the stake of the fill proof.

  node --env-file=.env <dir>/run.mjs sale_limit3.py      (from the app repo root)
-> data/local/x/bt/sale_limit3_summary.json, sale_limit3_sales.csv
"""
import bisect, collections, csv, gzip, json, math, multiprocessing as mp, os, statistics as st, sys
from datetime import datetime
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import size_volume as SV
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
from store import day

B = "data/local/x/bt"
TR = os.path.join(HERE, "dbx_cache", "trades911")
NY = ZoneInfo("America/New_York")
FAMILY = {"A": ("M1", "M3", "M5"), "B": ("L1", "L3", "L5"), "C": ("G3w10", "G3w20", "G5w10")}
STAKES = (5000, 10000)
MODES = ("bid-c5",) + tuple(f"{v}k{s // 1000}-c5" for f in FAMILY.values() for v in f for s in STAKES)   # -c5: the add within 5%
MORNING = {"morning_gap_keep", "morning_gap_against"}
for v in MODES: SV.SIZEV[v] = SV.SIZEV["t3A-c5"]

PR = {}


def stamp(x):
    """Databento's pretty ts (nanoseconds, Z) -> New York time."""
    x = x.replace("Z", "")
    if "." in x: a, b = x.split("."); x = f"{a}.{b[:6]}"
    return datetime.fromisoformat(x).replace(tzinfo=ZoneInfo("UTC")).astimezone(NY)


def prints(d):
    """{contract: sorted [(second of the session, price, size)]} for a day of the bought windows."""
    if d not in PR:
        if len(PR) > 6: PR.clear()
        by = collections.defaultdict(list)
        path = os.path.join(TR, f"{d}.csv.gz")
        if os.path.exists(path):
            with gzip.open(path, "rt") as f:
                for r in csv.DictReader(f):
                    ts = stamp(r["ts"])
                    sec = (ts.hour * 60 + ts.minute - 570) * 60 + ts.second + ts.microsecond / 1e6
                    by[r["contract"].replace(" ", "")].append((sec, float(r["price"]), int(float(r["size"]))))
        for v in by.values(): v.sort()
        PR[d] = by
    return PR[d]


def between(c, d, a, b):
    """Prints of contract c on day d with a <= second < b."""
    v = prints(d).get(c, [])
    return v[bisect.bisect_left(v, (a, -1, -1)):bisect.bisect_left(v, (b, -1, -1))]


def sell(mode, c, d, m, rule, share, contracts):
    """One sale under a mode -> (price, info). Decided on the book at the end of minute m - 1."""
    at = max(m - 1, 0)
    k = RB.quote(c, d, at)
    if not k: return None
    bid, ask = k
    mid = (bid + ask) / 2
    info = dict(bid=bid, ask=ask, mid=round(mid, 4), last=None, limit=None, filled=0.0, steps=0)
    if mode == "bid-c5": return bid, info
    name, stake = mode[:-3].split("k")
    kind, n = name[0], int(name[1])
    if kind == "G" and not (rule in MORNING and mid > 0 and (ask - bid) / mid >= int(name[3:]) / 100): return bid, info
    top = mid
    if kind == "L":
        p = between(c, d, m * 60 - 5, m * 60 + 1e-9)
        if p:
            info["last"] = p[-1][1]
            top = max(mid, p[-1][1])
    want = contracts * int(stake) / 5   # `contracts` is at the $5K stake
    left, got = want, 0.0
    for i in range(n):
        j = m + i
        if j > 389: break
        q0 = RB.quote(c, d, j - 1) if i else k   # the book the step is posted on
        if not q0: break
        L = bid + (top - bid) * (1 - i / n)
        L = math.floor(min(L, q0[1] - 0.01) * 100 + 1e-6) / 100
        if i == 0: info["limit"] = L
        info["steps"] = i + 1
        if L <= q0[0]:   # the fix: the bid then, not the decision minute's
            got += left * q0[0]; left = 0; break
        q = RB.quote(c, d, j)
        if q and q[0] >= L - 1e-9:   # the bid came up to the limit: all of it
            got += left * L; left = 0; break
        vol = sum(s for _, px, s in between(c, d, j * 60 + (1 if i == 0 else 0), (j + 1) * 60) if px >= L - 1e-9)
        f = min(left, vol)
        got += f * L; left -= f
        if left <= 1e-9: break
    if left > 1e-9:
        q = RB.quote(c, d, min(m + n - 1, 389))
        got += left * (q[0] if q else bid)
    info["filled"] = round(1 - left / want, 3) if want else 0
    return round(got / want, 4), info


def price(steps, c, cost, mode, sym, size_w, log):
    rcost, real = OS.price(steps, c[0], cost, "bid")
    if mode == "bid-c5" and log is None: return rcost, real
    contracts = 5000 * size_w / max(rcost, 0.01) / 100
    out = []
    for r in real:
        d, m, side, q, px, rule = r
        if side != "sell" or rule.endswith("_1s"): out.append(r); continue
        g = sell(mode, c[0], d, m, rule, q, max(1.0, contracts * q))
        if g is None: out.append(r); continue
        p, info = g
        out.append((d, m, side, q, round(p, 4), rule))
        if log is not None: log.append(dict(mode=mode, day=d, minute=m, rule=rule, share=q, got=round(p, 4), **info))
    return rcost, out


CAL = SV.CAL


def walk_modes(t, m, px):
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], px)
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, _ = OS.price(steps, c[0], cost, "bid")
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL, paid=rcost)
    if cost is None: return None
    w = SV.SIZEV["t3A-c5"](float(t.get("c_rvol") or 0))
    rcost, base = OS.price(steps, c[0], cost, "bid")
    sells = [s for s in base if s[2] == "sell" and s[0] == t["date"]]
    held = {}
    for mm in range(m, 390):
        q = RB.quote(c[0], t["date"], mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
    rows, log = {}, []
    for mode in MODES:
        rc, real = price(steps, c, cost, mode, t["sym"], w, log)
        rows[mode] = dict(r1=sim.result(rc, real, 0.01), r2=sim.result(rc, real, 0.02), r3=sim.result(rc, real, 0.03),
                          r15=sim.result(rc, real, 0.015), r05=sim.result(rc, real, 0.005),
                          over=int(any(s[2] == "carry" for s in steps)), h=booked(rc, real), held=held)
    for x in log: x.update(contract=c[0])
    return rows, log


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    got = walk_modes(t, m0, float(t["price"]))
    if got is None: return None
    rows, log = got
    for x in log: x.update(src=src, kind=kind, sym=t["sym"], part=half(t["date"]))
    return dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v=rows, at={v: m0 for v in rows}, log=log)


def table(R, adds, part, modes, out, title):
    for size in (0.02, 0.03):
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | vs 2.10 | Without the best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for v in modes:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(SV.entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                b = out.get(f"{part}|bid-c5|{src}|{size}", s)["acct"]
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | {s['acct'] / b:.3f} | ${s['no5']:,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)


def fills(L, part, modes):
    print(f"\n#### Fills, {part} weeks\n")
    print("| Version | List | Sales | Limit above the bid | Filled in full | Avg filled share | Avg vs the bid at once | With a print in the last 5 s |")
    print("|---|---|---|---|---|---|---|---|")
    for v in modes:
        if v == "bid-c5": continue
        for src in ("fair", "fav"):
            xs = [x for x in L if x["mode"] == v and x["src"] == src and x["part"] == part]
            if not xs: continue
            above = [x for x in xs if x["limit"] is not None and x["limit"] > x["bid"]]
            rel = [x["got"] / x["bid"] - 1 for x in xs if x["bid"] > 0]
            print(f"| {v} | {src} | {len(xs)} | {len(above)} | {sum(x['filled'] >= 0.999 for x in above)} | "
                  f"{st.mean([x['filled'] for x in above]) if above else 0:.0%} | {st.mean(rel) if rel else 0:+.1%} | {sum(x['last'] is not None for x in xs)} |", flush=True)


def main():
    days = {f[:10] for f in os.listdir(TR)} if os.path.isdir(TR) else set()
    print(f"trades bought for {len(days)} days", flush=True)
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    L = [x for r in R for x in r["log"]]
    with open(f"{B}/sale_limit3_sales.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(L[0].keys())); w.writeheader(); w.writerows(L)
    out = {}
    table(R, adds, "tune", MODES, out, "Tune weeks (even)")
    score = lambda v: min(out[f"tune|{v}|{s}|0.02"]["acct"] / out[f"tune|bid-c5|{s}|0.02"]["acct"] for s in ("fair", "fav"))
    picks = []
    for fam, vs in FAMILY.items():
        best = max((f"{v}k5-c5" for v in vs), key=score)
        picks.append(best)
        print(f"\n🎯 Idea {fam}, picked on tune ($5K proof, min of fair and Favorites vs 2.10, 2%): {best} ({score(best):.3f}); "
              f"$10K proof {score(best.replace('k5-', 'k10-')):.3f}", flush=True)
    out["picks"] = picks
    fills(L, "tune", ("bid-c5",) + tuple(picks))
    chk = ("bid-c5",) + tuple(x for p in picks for x in (p, p.replace("k5-", "k10-")))
    table(R, adds, "check", chk, out, "Check weeks (odd), the same run, the picks only")
    fills(L, "check", chk)
    json.dump(out, open(f"{B}/sale_limit3_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
