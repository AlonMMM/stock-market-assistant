"""Sell above the bid, look 4 (2026-11-05): a fast ladder in seconds. The user, after look 3 (the 5-minute steps lose 6%):
"what about try for 1sec the mids, than hold 5sec for mid-25% spread, than move to -50%, 75 than big" (read as: the
mid for 1 s, then 25% / 50% / 75% of the way from the mid to the bid, 5 s each, then the bid; ~16 s), then "go".

Built on 2.10 (size_volume.py t3A-c5), only the sale price changes. Data: Databento OPRA trades with sizes
(dbx_cache/trades911) and second-level books (dbx_cache/sec911: cbbo-1s from 2025-02-20, cmbp-1 before), bought for
the minutes around every 2.10 sale. The ladder starts at the decision (the start of minute m) from the decision book
(the end of minute m - 1, the price 2.10 sells at): limits mid - f x (mid - bid), f = 0 / 0.25 / 0.5 / 0.75, whole cents
rounded down, at most the ask - 1 cent. A step fills from prints at or above its limit inside its own seconds, up to
their summed size (the rest carries on), or in full once the second book's bid reaches the limit; a limit at or under
the bid of that second sells at that bid; what is left after the last step sells at the bid of that second.
Our contracts at a $5K stake x 2.10's volume size (the verdict) and $10K (shown), as look 3. Set before running:
  bid       2.10, the bid at once
  A  P3 P5 P10   mid 1 s, then 25 / 50 / 75% held 3 / 5 / 10 s each, then the bid (P5 = the user's)
  B  P5p         P5 on the planned exits only (the 09:40 gap our way, end of day, expiry day); the rest at the bid
One pick an idea on tune by min(fair, Favorites) vs 2.10 at 2% on the $5K proof; only the picks run on check.

  node --env-file=.env <dir>/run.mjs sale_sec4.py      (from the app repo root)
-> data/local/x/bt/sale_sec4_summary.json, sale_sec4_sales.csv
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
SB = os.path.join(HERE, "dbx_cache", "sec911")
NY = ZoneInfo("America/New_York")
FAMILY = {"A": ("P3", "P5", "P10"), "B": ("P5p",)}
STAKES = (5000, 10000)
MODES = ("bid-c5",) + tuple(f"{v}k{s // 1000}-c5" for f in FAMILY.values() for v in f for s in STAKES)   # -c5: the add within 5%
PLANNED = {"morning_gap_keep", "eod_close", "expiry_day"}
FRACS = (0, 0.25, 0.5, 0.75)
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


BK = {}


def books(d):
    """{contract: sorted [(second, bid, ask)]}, the book AT each second."""
    if d not in BK:
        if len(BK) > 6: BK.clear()
        by = collections.defaultdict(list)
        path = os.path.join(SB, f"{d}.csv.gz")
        if os.path.exists(path):
            with gzip.open(path, "rt") as f:
                for r in csv.DictReader(f):
                    b, a = float(r["bid"]), float(r["ask"])
                    if b > 0 and a > 0: by[r["contract"]].append((float(r["sec"]), b, a))
        for v in by.values(): v.sort()
        BK[d] = by
    return BK[d]


def book_at(c, d, s):
    v = books(d).get(c)
    if not v: return None
    i = bisect.bisect_right(v, (s, 1e9, 1e9)) - 1
    return v[i][1:] if i >= 0 and v[i][0] >= s - 120 else None


def between(c, d, a, b):
    """Prints of contract c on day d with a <= second < b."""
    v = prints(d).get(c, [])
    return v[bisect.bisect_left(v, (a, -1, -1)):bisect.bisect_left(v, (b, -1, -1))]


def sell(mode, c, d, m, rule, share, contracts):
    """One sale under a mode -> (price, info). Decided at the start of minute m on the book at the end of m - 1."""
    k = RB.quote(c, d, max(m - 1, 0))
    if not k: return None
    bid, ask = k
    mid = (bid + ask) / 2
    info = dict(bid=bid, ask=ask, mid=round(mid, 4), limit=None, filled=0.0, secs=0, sec_book=0)
    if mode == "bid-c5": return bid, info
    name, stake = mode[:-3].split("k")
    if name.endswith("p") and rule not in PLANNED: return bid, info
    hold = int(name[1:].rstrip("p"))
    want = contracts * int(stake) / 5
    left, got, t = want, 0.0, m * 60.0
    info["sec_book"] = int(book_at(c, d, t + 1) is not None)
    for n, f in enumerate(FRACS):
        dur = 1 if n == 0 else hold
        L = math.floor(min(mid - f * (mid - bid), ask - 0.01) * 100 + 1e-6) / 100
        if n == 0: info["limit"] = L
        now = book_at(c, d, t) or (bid, ask)
        if L <= now[0]:   # at or under the bid of that second: that bid
            got += left * now[0]; left = 0; break
        hit = False
        for s in range(int(t), int(t + dur)):
            q = book_at(c, d, s + 1)   # the book at the end of each second of the step
            if q and q[0] >= L - 1e-9: hit = True; break
        if hit: got += left * L; left = 0; break
        vol = sum(z for _, px, z in between(c, d, t, t + dur) if px >= L - 1e-9)
        x = min(left, vol); got += x * L; left -= x
        t += dur
        if left <= 1e-9: break
    info["secs"] = round(t - m * 60)
    if left > 1e-9:
        q = book_at(c, d, t) or RB.quote(c, d, m)
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
    print("| Version | List | Sales | Limit above the bid | Filled in full | Avg filled share | Avg vs the bid at once | With a second book |")
    print("|---|---|---|---|---|---|---|---|")
    for v in modes:
        if v == "bid-c5": continue
        for src in ("fair", "fav"):
            xs = [x for x in L if x["mode"] == v and x["src"] == src and x["part"] == part]
            if not xs: continue
            above = [x for x in xs if x["limit"] is not None and x["limit"] > x["bid"]]
            rel = [x["got"] / x["bid"] - 1 for x in xs if x["bid"] > 0]
            print(f"| {v} | {src} | {len(xs)} | {len(above)} | {sum(x['filled'] >= 0.999 for x in above)} | "
                  f"{st.mean([x['filled'] for x in above]) if above else 0:.0%} | {st.mean(rel) if rel else 0:+.1%} | {sum(x['sec_book'] for x in xs)} |", flush=True)


def main():
    days = {f[:10] for f in os.listdir(TR)} if os.path.isdir(TR) else set()
    print(f"trades bought for {len(days)} days, second books for {len(os.listdir(SB))} days", flush=True)
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    L = [x for r in R for x in r["log"]]
    with open(f"{B}/sale_sec4_sales.csv", "w", newline="") as f:
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
    json.dump(out, open(f"{B}/sale_sec4_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
