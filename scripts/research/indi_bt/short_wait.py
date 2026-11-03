"""A thin pick waits a few minutes for its 200 contracts, on the champion 2.10 (the user, 2026-11-03: "in 16:40 somtimes we
skip very good trade, like coin today, just because the specific delta option have no 200 volume. 2 minute later it
wasn't the case. I wonder how many case there is like this. and we're not try again stock that skipped"; COIN Call
157.5 6 Nov had 34 contracts at 09:40, 201 at 09:44, $1.02 then, $2.75 at 11:00 - after the data's end, 2026-10-16).
A main (and add) signal whose 0.15-delta pick passes the $0.20 floor ($0.10 IBIT) but has under 200 contracts in the
last 30 minutes: the SAME contract is checked again every following minute (its 30 minutes up to that minute, as
cheap_up.candidates counts); at the first minute it has 200 within the wait cap, it is bought there (the price at that
minute still over the floor), the walk, 2.10's exits and the book from that minute. No new strike, no new signal. One
trade a stock a day: no wait trade on a stock-day the champion already trades; two waits of one stock-day keep the
earliest. Set before running:
  champ   2.10 as is (thin_strike.py's champ)
  W2 / W5 / W10   the wait cap: 2 / 5 / 10 minutes
  W5open  W5, only for signals before 10:00
Prior: "the wait" (tiers.py BT_RETRY_ILLIQUID, 2026-10-24, the old champion and walk): every minute until 200, failed
the unseen list, the 1-5 minute waits the only positive bucket (+412 a trade, 112); open_window.py (2026-10-30): a
floor scaled by the minutes since the open, bought at the signal minute, failed the check; retry_skip.py (2026-11-03):
at the next alert, ~11-12 minutes, failed. Look 1 on the fixed walk for a capped wait on the same contract.
Lists: the fair list + the Favorites (24 months); tune = even entry weeks, check = odd (split.py), the same run; one pick
on tune by min(fair, Favorites) vs champ at 2%; check for champ and the pick, at 2% and 3%.

  node --env-file=.env <dir>/run.mjs short_wait.py      (from the app repo root)
-> data/local/x/bt/short_wait_summary.json, short_wait_added.csv, short_wait_count.json
"""
import collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from store import day
from split import half

B = "data/local/x/bt"
MODES = ("champ", "W2", "W5", "W10", "W5open")
CAP = {"W2": 2, "W5": 5, "W10": 10, "W5open": 5}
LAST = 374   # 15:44
SCAN = 30    # the count looks this far


def floor_of(sym):
    return 0.10 if sym == "IBIT" else 0.20


def vol30(c, date, m):
    return sum(y[5] for y in day(c, date) if m - 30 < y[0] <= m)


def price_at(c, date, m):
    b = sim.last_bar(day(c, date), m, cu.C["bar_max_age"])
    return b[4] if b else None


def first(job):
    """The pick; a thin one's first minute at 200 (the same contract, within SCAN, over the floor then)."""
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], spot)
    if not cands: return None
    b = min(cands, key=lambda c: abs(c[3] - 0.15))
    if b[4] < floor_of(t["sym"]): return None
    base = dict(src=src, kind=kind, t=t, m0=m0, best=b)
    if b[5] >= 200: return dict(base, wait=0, at=m0)
    hit = None
    for m in range(m0 + 1, min(m0 + SCAN, LAST) + 1):
        if vol30(b[0], t["date"], m) >= 200:
            px = price_at(b[0], t["date"], m)
            if px is not None and px >= floor_of(t["sym"]): hit = m
            break
    return dict(base, wait=None if hit is None else hit - m0, at=hit)


def modes_for(p):
    if p["wait"] == 0: return list(MODES)
    if p["wait"] is None: return []
    return [v for v, c in CAP.items() if p["wait"] <= c and p["at"] <= LAST and (v != "W5open" or p["m0"] < 30)]


def walk(job):
    p, modes, what = job
    if RB.DBX != fm.DBX[p["src"]]: RB.DBX = fm.DBX[p["src"]]; RB.Q.clear(); RB.OI.clear()
    t, b = p["t"], p["best"]
    m = p["m0"] if what == "atsignal" else p["at"]
    row = TS.walk_c(dict(t, minute=m), m, b)
    if row is None: return None
    info = dict(contract=b[0], strike=b[2], delta=round(abs(b[3]), 3), price=b[4], vol30=b[5], m0=p["m0"], wait=p["wait"],
                book=bool(RB.quote(b[0], t["date"], m)))
    return dict(src=p["src"], kind=p["kind"], date=t["date"], minute=m, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), what=what,
                v={x: row for x in modes}, pick={x: info for x in modes})


def legs(P):
    """Main legs per mode under one trade a stock a day; adds as their signal allows."""
    mains = [p for p in P if p["kind"] == "main"]
    bought = {(p["src"], p["t"]["sym"], p["t"]["date"]) for p in mains if p["wait"] == 0}
    keep = collections.defaultdict(dict)   # stock-day -> mode -> p
    for p in mains:
        if not p["wait"]: continue
        k = (p["src"], p["t"]["sym"], p["t"]["date"])
        if k in bought: continue
        for v in modes_for(p):
            have = keep[k].get(v)
            if have is None or p["at"] < have["at"]: keep[k][v] = p
    jobs = collections.defaultdict(list)
    for p in mains:
        if p["wait"] == 0: jobs[id(p)] = (p, list(MODES))
    for k, ms in keep.items():
        for v, p in ms.items():
            jobs.setdefault(id(p), (p, []))[1].append(v)
    for p in P:
        if p["kind"] == "add" and modes_for(p): jobs[id(p)] = (p, modes_for(p))
    return [(p, ms, "entry") for p, ms in jobs.values()]


def count(P, R0, out):
    """The user's question: how many thin skips reach 200 on the same contract, and how soon."""
    print("\n#### Thin skips (main, price floor passed, under 200): minutes until the same contract has 200 (all weeks)\n")
    print("| List | Signal time | Thin skips | 1 min | 2 min | 5 min | 10 min | 30 min | never in 30 |")
    print("|---|---|---|---|---|---|---|---|---|")
    for src, a in (("fair", ""), ("fav", FR.A24)):
        th = [p for p in P if p["src"] == src and p["kind"] == "main" and p["wait"] != 0 and p["t"]["date"] >= a]
        for lab, lo, hi in (("all", 0, 999), ("before 10:00", 0, 30), ("10:00-12:00", 30, 150), ("after 12:00", 150, 999)):
            x = [p for p in th if lo <= p["m0"] < hi]
            cnt = [sum(p["wait"] is not None and p["wait"] <= w for p in x) for w in (1, 2, 5, 10, 30)]
            out[f"count|{src}|{lab}"] = dict(n=len(x), within=dict(zip((1, 2, 5, 10, 30), cnt)))
            pc = " | ".join(f"{c} ({c / max(1, len(x)):.0%})" for c in cnt)
            print(f"| {src} | {lab} | {len(x)} | {pc} | {len(x) - cnt[-1]} |", flush=True)
    print("\n#### Their result at $10K (main legs, all weeks): bought when 200 is reached within 5 min, vs the rest bought at the signal (fill unproven)\n")
    print("| List | Group | Part | Trades | Winners | Median | Sum | Giants | Non-giant sum |")
    print("|---|---|---|---|---|---|---|---|---|")
    for src, a in (("fair", ""), ("fav", FR.A24)):
        for grp in ("within 5 (at 200)", "never in 30 (at the signal)", "6-30 (at the signal)"):
            for part in ("tune", "check"):
                if grp.startswith("within"):
                    x = [r for r in R0 if r["src"] == src and r["kind"] == "main" and r["what"] == "entry" and "champ" not in r["v"]
                         and r["pick"][next(iter(r["pick"]))]["wait"] <= 5]
                else:
                    never = grp.startswith("never")
                    x = [r for r in R0 if r["src"] == src and r["what"] == "atsignal"
                         and ((r["pick"]["x"]["wait"] is None) if never else (r["pick"]["x"]["wait"] is not None and r["pick"]["x"]["wait"] > 5))]
                x = [r for r in x if r["date"] >= a and half(r["date"]) == part]
                rr_ = [max(-1, next(iter(r["v"].values()))["r1"]) for r in x]
                usd = [1e4 * q for q in rr_]
                g = [u for q, u in zip(rr_, usd) if q >= 3]
                s = dict(n=len(x), win=sum(u > 0 for u in usd), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)),
                         giants=len(g), nongiant=round(sum(usd) - sum(g)))
                out[f"result|{src}|{grp}|{part}"] = s
                print(f"| {src} | {grp} | {part} | {s['n']} | {s['win']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} |", flush=True)


def added(R, part, out, versions, rows_out):
    print(f"\n#### {part} weeks: the waited main trades (at $10K)\n")
    print("| Version | List | Trades | Winners | Median | Sum | Giants | Non-giant sum | Without their best 5 | Wait (median min) | Before 10:00 | By year | Top names |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for v in versions:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            h = [r for r in R if r["src"] == src and r["kind"] == "main" and r["what"] == "entry" and half(r["date"]) == part
                 and r["date"] >= a and v in r["v"] and "champ" not in r["v"]]
            usd = [1e4 * max(-1, r["v"][v]["r1"]) for r in h]
            g = [u for r, u in zip(h, usd) if r["v"][v]["r1"] >= 3.0]
            years, names = collections.defaultdict(float), collections.defaultdict(float)
            for r, u in zip(h, usd): years[r["date"][:4]] += u; names[r["sym"]] += u
            s = dict(n=len(h), win=sum(u > 0 for u in usd), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)),
                     giants=len(g), nongiant=round(sum(usd) - sum(g)), no5=round(sum(sorted(usd)[:-5])) if len(usd) > 5 else 0,
                     wait=st.median([r["pick"][v]["wait"] for r in h]) if h else None,
                     early=sum(r["pick"][v]["m0"] < 30 for r in h),
                     book=round(sum(r["pick"][v]["book"] for r in h) / max(1, len(h)), 3),
                     years={y: round(x) for y, x in sorted(years.items())},
                     top=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: -kv[1])[:4]],
                     bottom=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: kv[1])[:3]])
            out[f"{part}|{v}|{src}|added"] = s
            yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
            print(f"| {v} | {src} | {s['n']} | {s['win']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} | {s['no5']:+,} | {s['wait']} | {s['early']} | {yrs} | {', '.join(s['top'])}; worst {', '.join(s['bottom'])} |", flush=True)
            for r, u in zip(h, usd):
                p = r["pick"][v]
                rows_out.append(dict(part=part, version=v, list=src, date=r["date"], signal_minute=p["m0"], minute=r["minute"], wait=p["wait"],
                                     sym=r["sym"], right=r["right"], contract=p["contract"], delta=p["delta"], price=p["price"],
                                     vol30_at_signal=p["vol30"], book=int(p["book"]), usd10k=round(u)))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    coin = [j for j in jobs if j[2]["sym"] == "COIN" and j[2]["date"] >= "2026-11-01"]
    print("COIN 2026-11-03 in the data:", bool(coin), flush=True)
    with mp.Pool(8) as pool: P = [p for p in pool.map(first, jobs, chunksize=4) if p]
    print("pass 1:", dict(collections.Counter((p["src"], p["kind"], "ok" if p["wait"] == 0 else ("never" if p["wait"] is None else "waits")) for p in P)), flush=True)
    W = legs(P)
    diag = [(p, ["x"], "atsignal") for p in P if p["kind"] == "main" and p["wait"] != 0 and (p["wait"] is None or p["wait"] > 5)]
    print(f"legs: {len(W)} (+{len(diag)} diagnostic walks at the signal)", flush=True)
    with mp.Pool(8) as pool: R0 = [r for r in pool.map(walk, W + diag, chunksize=4) if r]
    R = [r for r in R0 if r["what"] == "entry"]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out, rows = {}, []
    count(P, R0, out)
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    pk = max(MODES[1:], key=score)
    out["pick"] = pk
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs champ, 2%): {pk} ({score(pk):.3f}); better on both: {score(pk) > 1}")
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the pick only", ("champ", pk))
    added(R, "tune", out, MODES[1:], rows)
    added(R, "check", out, (pk,), rows)
    json.dump(out, open(f"{B}/short_wait_summary.json", "w"), indent=1)
    with open(f"{B}/short_wait_added.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
