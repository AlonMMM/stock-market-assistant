"""A lower price floor for chosen tickers (the user, 2026-10-27: "IBIT is special - because it have best trades for al the
times. I want you to add IBIT as a default to have a limit of 0.1$ in premina and not 0.2. also test after it what will
happen if we add like this all the tickers that have options 3 times or more a week (APPL TSLA etc.) to that
exceptioon"). For a ticker on the list the 0.15-delta option is bought down to $0.10 (and the cheap fallback, where on,
steps in under $0.10 and picks from $0.10); every other ticker keeps $0.20. Set before running:
  off     no exception
  ibit    IBIT only
  x3now   today's tickers with option expiries 3+ days a week (expiry_days.py, Oct 2026), over the whole period
  x3pit   the same, point in time: a ticker counts from the month it had them (only GLD / IWM before 2026-02)
Bots: 2.5 (no fallback) and 2.6 (the cheap fallback), and the pyramid on each (the half-size add on 2.4's entry while the
D2 leg is held and up on the real mid, fav_real.py / cand_real.py). Lists: the fair list (2024-25 tuning, 2026 held out)
and today's 69 Favorites (24 / 12 / 6 months). Real quotes (opt_spread.price "bid"), the 10% overnight cap, $0.62 a
contract each way; `cov` = the share of trades fully on the book (a fill with no quote keeps its +-2% price).

  node --env-file=.env <dir>/run.mjs floor_exception.py      (from the app repo root)
-> data/local/x/bt/floor_exception_summary.json, floor_exception_trades.csv
"""
import csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import cheap_up2 as cu2
import news_filter as nf
import opt_spread as OS
import real_bench as RB
import fav_real as FR
from d2_failed_break import CHAMP
from low_delta import HIS40, PRIOR
from score_sum import account
from store import calendar
from split import half

B = "data/local/x/bt"
CAL = calendar()
DBX = {"fair": os.path.join(HERE, "dbx_cache", "indi"), "fav": os.path.join(HERE, "dbx_cache", "fav")}
X3 = json.load(open(f"{B}/expiry_days.json"))
X3NOW = set(X3["2026-10"]) | set(X3["2026-09"])
LISTS = {"off": lambda s, d: False, "ibit": lambda s, d: s == "IBIT", "x3now": lambda s, d: s in X3NOW,
         "x3pit": lambda s, d: s in X3.get(d[:7], ())}
FBS = ("none", "cheap")


def choose(cands, floor, fb):
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    src = "pick"
    if fb == "cheap" and best[4] < floor:
        ok = [c for c in cands if c[4] >= floor and abs(c[3]) >= abs(best[3])]
        if not ok: return None
        best = min(ok, key=lambda c: c[4]); src = "cheap"
    if best[4] < floor or best[5] < 200: return None
    return best, src


def one(job):
    src, kind, t = job   # kind: main (2.5's entry) / add (2.4's entry, the pyramid's add)
    if RB.DBX != DBX[src]: RB.DBX = DBX[src]; RB.Q.clear(); RB.OI.clear()
    m, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], spot)
    walked, out = {}, []
    for lname, on in LISTS.items():
        floor = 0.10 if on(t["sym"], t["date"]) else 0.20
        for fb in FBS:
            p = choose(cands, floor, fb)
            if not p: continue
            c, how = p
            if c[0] not in walked:
                sim.X.clear(); sim.X.update(CHAMP)
                cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
                if cost is None: walked[c[0]] = None; continue
                rcost, real = OS.price(steps, c[0], cost, "bid")
                fills = [s for s in steps if s[2] in ("buy", "sell")]
                row = dict(r1=sim.result(rcost, real, 0.01), r2=sim.result(rcost, real, 0.02), r05=sim.result(rcost, real, 0.005),
                           cov=int(all(RB.quote(c[0], s[0], max(s[1] - 1, 0)) for s in fills)), price=c[4])
                if kind == "main":
                    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
                    held = {}
                    for mm in range(m, 390):
                        k = RB.quote(c[0], t["date"], mm)
                        held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
                    row["held"] = held
                walked[c[0]] = row
            if not walked[c[0]]: continue
            out.append(dict(src=src, kind=kind, exc=lname, fb=fb, date=t["date"], minute=m, sym=t["sym"], right=t["right"], contract=c[0],
                            how=how, d2=int(float(t.get("c_t") or 9) < 1.8), **walked[c[0]]))
    return out


def fair_signals(prefix):
    T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    return [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40
            and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST]


def entries(R, src, exc, fb, pyramid):
    main = [r for r in R if r["src"] == src and r["kind"] == "main" and r["exc"] == exc and r["fb"] == fb]
    adds = {}
    for r in R:
        if r["src"] == src and r["kind"] == "add" and r["exc"] == exc and r["fb"] == fb: adds.setdefault((r["date"], r["sym"], r["right"]), []).append(r)
    E = []
    for r in main:
        E.append((r["date"], r["minute"], 1.0, r["r1"], r["r2"], r["sym"], r["cov"]))
        if not (pyramid and r["d2"]): continue
        for a in sorted(adds.get((r["date"], r["sym"], r["right"]), []), key=lambda x: x["minute"]):
            if a["minute"] <= r["minute"]: continue
            share, up = r["held"].get(a["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((a["date"], a["minute"], 0.5, a["r05"], a["r1"], a["sym"], a["cov"]))
            break
    return E


def stats(E, a, z, size, part=None):
    R = sorted(e for e in E if a <= e[0] <= z and (part is None or half(e[0]) == part))
    if not R: return None
    k = 3 if size == 0.01 else 4
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[k]))) for e in R]
    acct, dd = account(pnl, size)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], size)
    return dict(trades=len(R), winners=sum(e[3] > 0 for e in R), acct=round(acct), dd=round(dd, 3), no5=round(a5), cov=round(sum(e[6] for e in R) / len(R), 3),
                best5=[f"{R[i][5]} {R[i][0]} {1e4 * R[i][2] * R[i][3]:+,.0f}" for i in sorted(top, key=lambda i: -R[i][2] * R[i][3])])


def main():
    jobs = [("fair", "main", t) for t in fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for rows in pool.map(one, jobs, chunksize=4) for r in rows]
    with open(f"{B}/floor_exception_trades.csv", "w") as f:
        keys = [k for k in R[0] if k != "held"]
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore"); w.writeheader(); w.writerows(R)
    out = {}
    cuts = {"fair": (("2024-25", "2024-01-01", "2025-12-31"), ("2026", "2026-01-01", "2026-12-31")),
            "fav": (("24m", FR.A24, "9"), ("12m", FR.A12, "9"), ("6m", FR.A6, "9"))}
    for src in ("fair", "fav"):
        print(f"\n### {src}, real quotes, 1% (2% for the first period)\n")
        print("| Bot | Exception | " + " | ".join(c[0] for c in cuts[src]) + f" | {cuts[src][0][0]} at 2% | {cuts[src][0][0]} without the best 5 | Fully on the book |")
        print("|---|---|" + "---|" * (len(cuts[src]) + 3))
        for fb in FBS:
            for pyr in (False, True):
                bot = {("none", False): "2.5", ("cheap", False): "2.6", ("none", True): "pyramid, no cheap", ("cheap", True): "pyramid"}[(fb, pyr)]
                for exc in LISTS:
                    E = entries(R, src, exc, fb, pyr)
                    s = [stats(E, a, z, 0.01) for _, a, z in cuts[src]]
                    s2 = stats(E, cuts[src][0][1], cuts[src][0][2], 0.02)
                    out[f"{src}|{bot}|{exc}"] = dict(periods={c[0]: x for c, x in zip(cuts[src], s)}, first_2pct=s2)
                    cells = " | ".join(f"${x['acct']:,} / {x['dd']:.0%} ({x['trades']})" for x in s)
                    print(f"| {bot} | {exc} | {cells} | ${s2['acct']:,} / {s2['dd']:.0%} | ${s[0]['no5']:,} | {s[0]['cov']:.0%} |", flush=True)
    # the tune / check split (split.py): the same versions on even and odd entry weeks
    for src, a, z in (("fair", "", "9"), ("fav", FR.A24, "9")):
        print(f"\n### {src}, tune (even weeks) / check (odd weeks), real quotes, 1%\n")
        print("| Bot | Exception | Tune | Check | Tune without the best 5 | Check without the best 5 |\n|---|---|---|---|---|---|")
        for fb in FBS:
            for pyr in (False, True):
                bot = {("none", False): "2.5", ("cheap", False): "2.6", ("none", True): "pyramid, no cheap", ("cheap", True): "pyramid"}[(fb, pyr)]
                for exc in LISTS:
                    E = entries(R, src, exc, fb, pyr)
                    t, c = stats(E, a, z, 0.01, "tune"), stats(E, a, z, 0.01, "check")
                    out[f"split|{src}|{bot}|{exc}"] = dict(tune=t, check=c)
                    print(f"| {bot} | {exc} | ${t['acct']:,} / {t['dd']:.0%} ({t['trades']}) | ${c['acct']:,} / {c['dd']:.0%} ({c['trades']}) | ${t['no5']:,} | ${c['no5']:,} |", flush=True)
    json.dump(out, open(f"{B}/floor_exception_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
