"""Optimizing the cheap fallback (the user, 2026-10-27: "Can we optimized the cheaper fallback?"). On 2.5's entries and
exits (sg_c12_15 trade files after the news filter, CHAMP), every signal re-picked; only the contract changes. Set
before running:
  2.5      no fallback: the 0.15-delta strike, $0.20 or more, 200+ contracts in 30 minutes
  2.6      the live rule: under $0.20, the cheapest strike at $0.20+ toward the money (cheap_up.py "cheap")
  2.6*     the same with $0.15 for both the floor and the fallback (live runs minPrice 0.15)
  floor30  under $0.20, the cheapest strike at $0.30+ toward the money
  floor50  the same at $0.50+
  d25      under $0.20, the strike nearest delta 0.25 among those at $0.20+
  d30      the same, delta 0.30
  band10   2.6, but only when the 0.15-delta option is still $0.10 or more (else no trade)
The 200-contract floor applies to every final pick. Lists: the fair list (2024-25 tuning, 2026 held out), at the bar's
middle +- 2% and on the real book (opt_spread.price "bid", the fair list's Databento cache; `cov` = the share of fills
on the book), the 151 unseen stocks (+- 2% only), where 2.6's fallback lost before, and, the user's out-of-sample check
(2026-10-27: "since we know indy trade "hot" stocks we need the sort of the same"), the hot stocks: hot_universe.py's
monthly top 50 by daily volatility over the 6 months before (the whole optionable market, liquid, point in time),
minus Indi's 40, kept to the 67 whose options fit the bot (opt_fit.py, an Oct 2026 snapshot), each traded only in a
month it is hot (hot_6m.json); 2.5's signals there are lists.py's hotfit_25 (+- 2% only: no quotes cached). 1% / 2% from $100,000, the 10%
overnight cap, $0.62 a contract each way.

  node --env-file=.env <dir>/run.mjs cheap_opt.py      (from the app repo root)
-> data/local/x/bt/cheap_opt_summary.json, cheap_opt_trades.csv
"""
import csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import news_filter as nf
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from low_delta import HIS40, PRIOR
from score_sum import account
from store import calendar

B = "data/local/x/bt"
CAL = calendar()
VOL = 200
# name -> (floor of the plain pick, when the fallback steps in, how it picks, the fallback's floor, lowest 0.15 price it takes)
V = {
    "2.5": (0.20, None, None, None, None),
    "2.6": (0.20, 0.20, "cheapest", 0.20, None),
    "2.6*": (0.15, 0.15, "cheapest", 0.15, None),
    "floor30": (0.20, 0.20, "cheapest", 0.30, None),
    "floor50": (0.20, 0.20, "cheapest", 0.50, None),
    "d25": (0.20, 0.20, 0.25, 0.20, None),
    "d30": (0.20, 0.20, 0.30, 0.20, None),
    "band10": (0.20, 0.20, "cheapest", 0.20, 0.10),
}


def choose(cands, rule):
    floor, under, how, ffloor, band = rule
    if not cands: return None, None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    src = "pick"
    if under is not None and best[4] < under:
        if band is not None and best[4] < band: return None, None
        ok = [c for c in cands if c[4] >= ffloor and abs(c[3]) >= abs(best[3])]
        if not ok: return None, None
        best = min(ok, key=lambda c: c[4]) if how == "cheapest" else min(ok, key=lambda c: abs(abs(c[3]) - how))
        src = "fallback"
    if best[4] < floor or best[5] < VOL: return None, None
    return best, src


def one(t):
    m, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], spot)
    fair = t.get("src") != "hot" and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]
    lname = t.get("src") or ("fair" if fair else ("unseen" if t["sym"] not in HIS40 else "other"))
    walked, out = {}, []
    for name, rule in V.items():
        c, src = choose(cands, rule)
        if not c: continue
        if c[0] not in walked:
            sim.X.clear(); sim.X.update(CHAMP)
            cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
            if cost is None: walked[c[0]] = None; continue
            row = dict(f2_1=sim.result(cost, steps, 0.01), f2_2=sim.result(cost, steps, 0.02))
            if fair:
                rcost, real = OS.price(steps, c[0], cost, "bid")
                fills = [s for s in steps if s[2] in ("buy", "sell")]
                row.update(real_1=sim.result(rcost, real, 0.01), real_2=sim.result(rcost, real, 0.02),
                           cov=sum(bool(RB.quote(c[0], s[0], max(s[1] - 1, 0))) for s in fills) / len(fills))
            walked[c[0]] = row
        if not walked[c[0]]: continue
        out.append(dict(version=name, list=lname, date=t["date"], minute=m,
                        sym=t["sym"], right=t["right"], contract=c[0], delta=round(abs(c[3]), 3), price=c[4], vol30=c[5], src=src, **walked[c[0]]))
    return out


def stats(R, key, size):
    R = sorted(R, key=lambda r: (r["date"], r["minute"]))
    if not R: return None
    pnl = [dict(date=r["date"], pnl=str(1e4 * max(-1, r[key]))) for r in R]
    a, dd = account(pnl, size)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][key])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], size)
    return dict(trades=len(R), winners=sum(r[key] > 0 for r in R), per=round(sum(float(p["pnl"]) for p in pnl) / len(R)), acct=round(a), dd=round(dd, 3),
                no5=round(a5), years={y: round(sum(1e4 * max(-1, r[key]) for r in R if r["date"][:4] == y)) for y in ("2024", "2025", "2026")},
                best5=[f"{R[i]['sym']} {R[i]['date']} {1e4 * R[i][key]:+,.0f}" for i in sorted(top, key=lambda i: -R[i][key])])


def main():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["date"] <= RB.LAST
         and (t["sym"] not in HIS40 or t["sym"] in PRIOR[t["date"][:4]])]
    HOT6 = {m: set(v) for m, v in json.load(open(f"{B}/hot_6m.json")).items()}
    for r in json.load(open(f"{B}/list_hotfit_25_2024-02-01_2026-10-23.json")):
        st = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}.get(r["status"])
        if st and r["sym"] in HOT6.get(r["date"][:7], ()) and r["date"] <= RB.LAST: T.append(dict(r, status=st, src="hot", minute=str(r["minute"])))
    print(len(T), "signals,", sum(t.get("src") == "hot" for t in T), "on the hot stocks", flush=True)
    with mp.Pool(8) as pool: R = [r for rows in pool.map(one, T, chunksize=4) for r in rows]
    with open(f"{B}/cheap_opt_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(dict.fromkeys(k for r in R for k in r))); w.writeheader(); w.writerows(R)
    out = {}
    for lname, cuts in (("fair", (("2024-25", "2024-01-01", "2025-12-31"), ("2026", "2026-01-01", "2026-12-31"))), ("unseen", (("all", "", "9"),)), ("hot", (("2024-25", "2024-01-01", "2025-12-31"), ("2026", "2026-01-01", "2026-12-31"), ("all", "", "9")))):
        print(f"\n### {lname}\n")
        print("| Version | Period | Trades | Fallback trades | Winners | Per trade | ±2% 1% / drop | ±2% 2% / drop | Real 1% / drop | Real 2% / drop | Without best 5 (1%, real or ±2%) | Years ±2% | Fully on the book |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for name in V:
            for per, a, z in cuts:
                rows = [r for r in R if r["version"] == name and r["list"] == lname and a <= r["date"] <= z]
                if not rows: continue
                f1, f2 = stats(rows, "f2_1", 0.01), stats(rows, "f2_2", 0.02)
                r1 = stats(rows, "real_1", 0.01) if lname == "fair" else None
                r2 = stats(rows, "real_2", 0.02) if lname == "fair" else None
                fb = sum(r["src"] == "fallback" for r in rows)
                full = f"{sum(r['cov'] == 1 for r in rows) / len(rows):.0%}" if lname == "fair" else ""
                real1 = f"${r1['acct']:,} / {r1['dd']:.0%}" if r1 else ""
                real2 = f"${r2['acct']:,} / {r2['dd']:.0%}" if r2 else ""
                no5 = (r1 or f1)["no5"]
                yrs = " / ".join(f"{f1['years'][y]:+,}" for y in ("2024", "2025", "2026"))
                print(f"| {name} | {per} | {len(rows)} | {fb} | {f1['winners']} | {f1['per']:+,} | ${f1['acct']:,} / {f1['dd']:.0%} | ${f2['acct']:,} / {f2['dd']:.0%} | "
                      f"{real1} | {real2} | ${no5:,} | {yrs} | {full} |", flush=True)
                out[f"{lname}|{name}|{per}"] = dict(f2_1=f1, f2_2=f2, real_1=r1, real_2=r2, fallback=fb)
    json.dump(out, open(f"{B}/cheap_opt_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
