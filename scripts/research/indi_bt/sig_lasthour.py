"""nightly-bet: the main bot's bought signals, held overnight when the last hour was flat or gave back.
The user 2026-10-31: "lets go again to the origin main bot signal. lets take only what it's theoreticaly buy during the
day, and buy it if the last hour (check on 15:50) its flat or give back. what would happen?"

Bets: every signal-day of the main bot (research twin c12_15, files sg_c12_15_20*_trades.csv) whose day signal was
bought (status ok: liquid, priced, filled; the 2,043 of 19,574), Feb 2024 on, its side (C / P). No Friday night, no
earnings night or morning (nightly_feat.py's earn flag). At 15:50: the last hour = the stock's move 14:50 -> 15:50 on
the bet's side, in that day's usual hour move (the sd of its 1-minute returns 09:45-14:50 x sqrt 60; same day only).
  all     no last-hour check (the base)
  lh000   bought when the last hour <= 0 (gave back)
  lh050   bought when <= +0.5 usual hour moves (flat or gave back: the thesis)
  lh100   bought when <= +1.0
Each: bought at 15:57, delta 0.20, the next-day expiry if liquid else the nearest liquid one 1-4 days out (indi_close
"fb"), $0.20 and 200 contracts in the last 30 minutes; sold next morning by his exit (indi_close walk, real Databento
quotes at the bid, 10% night cap). Every bet of a night taken, 2% each. Picked on tune among lh000 / lh050 / lh100 by
the average per bet; the pick and all on check, in the same run. Big winners (+300%) counted as in bigrate.py.
Quotes: IC_PASS=list -> open29_dbx_list.csv, dbx_fetch.py open29.

  node --env-file=.env <dir>/run.mjs sig_lasthour.py      (from the app repo root)
"""
import collections, csv, datetime as dt, glob, gzip, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import indi_close as ic
import retry_roll as rr
from store import day
from split import half

ic.EXTRAS += [os.path.join(HERE, "dbx_cache", "open29")]
B = "data/local/x/bt"
LEVELS = {"lh000": 0.0, "lh050": 0.5, "lh100": 1.0}


def lasthour(job):
    sym, date, right = job
    b = {x[0]: x for x in day(sym, date)}
    if 387 not in b or 380 not in b or 320 not in b: return job, None
    rets = [math.log(b[m][4] / b[m - 1][4]) for m in range(16, 321) if m in b and m - 1 in b and b[m - 1][4] > 0]
    if len(rets) < 100: return job, None
    sd = st.pstdev(rets) * math.sqrt(60) or 1e-4
    bet = 1 if right == "C" else -1
    return job, dict(lh=bet * math.log(b[380][4] / b[320][4]) / sd, px=b[387][4])


def walk(job):
    key, r, right = job
    return key, ic.walk(("fair", r, right, 0.20, "fb", "his"))


def row(T):
    r = [max(-1.0, w["r"][0.02]) for w in T]
    if not r: return None
    big = [x for x in r if x >= 3]; rest = [x for x in r if x < 3]
    acc = rr.stats([(w["date"], 389, 1.0, w["r"][0.02], 1) for w in T], 0.02)
    a3 = rr.stats([(w["date"], 389, 1.0, w["r"][0.03], 1) for w in T], 0.03)
    yrs = collections.Counter(w["date"][:4] for w in T)
    yr = ", ".join(f"{y}: {st.fmean([max(-1, w['r'][0.02]) for w in T if w['date'][:4] == y]):+.0%} ({n})" for y, n in sorted(yrs.items()))
    s = sorted(r)
    return (f"{len(r)} | {len(big)}" + (f" (1 in {len(r) / len(big):.0f})" if big else "") +
            f" | {st.fmean(big) if big else 0:+.0%} | {st.fmean(rest) if rest else 0:+.0%} | {st.fmean(r):+.0%} | {st.median(r):+.0%} | "
            f"{st.fmean(s[:-5]) if len(s) > 5 else 0:+.0%} | ${acc['acct']:,} / {acc['dd']:.0%} | ${a3['acct']:,} / {a3['dd']:.0%} | {yr}"), st.fmean(r)


def main():
    sig = {}
    for f in sorted(glob.glob(f"{B}/sg_c12_15_20*_trades.csv")):
        for r in csv.DictReader(open(f)):
            if r["status"] == "ok": sig[(r["sym"], r["date"], r["right"])] = r
    earn = {}
    with gzip.open(f"{B}/nightly_feat.csv.gz", "rt") as fh:
        for r in csv.DictReader(fh): earn[(r["sym"], r["date"], r["side"])] = r["earn"] == "1"
    keys = [k for k in sig if k[1] >= ic.A0 and k[1] <= ic.RB.LAST and dt.date.fromisoformat(k[1]).weekday() != 4
            and not earn.get(k, False) and rr.CAL.index(k[1]) + 1 < len(rr.CAL)]
    print(f"bought signal-days {len(sig):,}; Feb 2024 on, no Friday / earnings {len(keys):,} "
          f"(in nightly_feat {sum(k in earn for k in keys):,})", flush=True)
    with mp.Pool(8) as p: LH = {k: v for k, v in p.map(lasthour, sorted(keys), chunksize=20) if v}
    print(f"with 15:50 bars {len(LH):,}; last hour <= 0: {sum(v['lh'] <= 0 for v in LH.values()):,}, <= 0.5: "
          f"{sum(v['lh'] <= 0.5 for v in LH.values()):,}, <= 1.0: {sum(v['lh'] <= 1 for v in LH.values()):,}", flush=True)
    jobs = [((s, d, rt), {"sym": s, "date": d, "px": v["px"]}, rt) for (s, d, rt), v in LH.items()]
    with mp.Pool(8) as p: W = {k: w for k, w in p.map(walk, jobs, chunksize=4) if w}
    if ic.LISTING:
        rows = sorted({x for w in W.values() for x in w})
        with open(os.path.join(HERE, "open29_dbx_list.csv"), "w") as fh:
            wr = csv.writer(fh); wr.writerow(["date", "contract", "minute"]); wr.writerows(rows)
        print(f"{len(rows)} rows on {len({x[0] for x in rows})} days -> open29_dbx_list.csv"); return
    print(f"got an option: {len(W):,} of {len(LH):,}", flush=True)
    sel = {"all": lambda v: True, **{n: (lambda lv: lambda v: v["lh"] <= lv)(lv) for n, lv in LEVELS.items()}}
    T = lambda n, part: sorted((W[k] for k in W if half(k[1]) == part and sel[n](LH[k])), key=lambda w: w["date"])
    head = ("| Version | Half | Bets | Big (+300%) | Their avg | Others' avg | Per bet | Median | Per bet without best 5 | "
            "$100K at 2% / worst drop | at 3% | Per bet by year (bets) |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
    print("\n#### Tune weeks\n\n" + head)
    mean = {}
    for n in sel:
        out = row(T(n, "tune"))
        if out: print(f"| {n} | tune | {out[0]} |"); mean[n] = out[1]
    pick = max(LEVELS, key=lambda n: mean.get(n, -9))
    print(f"\nPicked on tune: {pick} 🎯\n\n#### Check weeks\n\n" + head)
    for n in ("all", pick):
        out = row(T(n, "check"))
        if out: print(f"| {n} | check | {out[0]} |")
    # the other side: the last hour ran (> +0.5), both halves, as a contrast (not a candidate)
    for part in ("tune", "check"):
        out = row(sorted((W[k] for k in W if half(k[1]) == part and LH[k]["lh"] > 0.5), key=lambda w: w["date"]))
        if out: print(f"| ran (> +0.5), contrast | {part} | {out[0]} |")
    bk = [w["book"] for w in W.values()]
    print(f"\nfills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    json.dump([dict(date=w["date"], sym=w["sym"], right=w["right"], contract=w["contract"], lh=LH[k]["lh"],
                    r={str(a): x for a, x in w["r"].items()}) for k, w in W.items()], open(f"{B}/sig_lasthour_trades.json", "w"))


if __name__ == "__main__":
    main()
