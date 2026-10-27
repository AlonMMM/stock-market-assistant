"""Open interest as the strike choice (the user, 2026-10-27: "OI as the strike choice: among strikes near 0.15 delta,
take the one with the most OI"). On the champion (2.5 + IBIT down to $0.10 + the pyramid, no cheap fallback), real
quotes. OI is the morning's (Databento statistics before the open: the open interest at the previous close), known
before any signal. Among the strikes the picker scans that pass the floor ($0.20, IBIT $0.10) and 200+ contracts in 30
minutes, set before running:
  now       the one nearest delta 0.15 (if it fails the floors, no trade: today's rule)
  oi-adj    the most OI among the 0.15-delta strike and its two neighbours
  oi-12-18  the most OI among those with delta 0.12 - 0.18
  oi-10-20  the most OI among those with delta 0.10 - 0.20
The OI rules choose among the passing strikes, so they also trade some signals today's rule skips (counted). The
pyramid's add uses the same rule. Tune / check by entry week (split.py), fair list and Favorites 24 months.

  node --env-file=.env <dir>/run.mjs oi_strike.py      (from the app repo root)
-> data/local/x/bt/oi_strike_summary.json
"""
import json, multiprocessing as mp, os, sys
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
RULES = ("now", "oi-adj", "oi-12-18", "oi-10-20")


def choose(cands, floor, rule, date):
    if not cands: return None, None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    ok = lambda c: c[4] >= floor and c[5] >= 200
    if rule == "now": return (best, "same") if ok(best) else (None, None)
    if rule == "oi-adj":
        ks = sorted(cands, key=lambda c: c[2])
        i = ks.index(best)
        pool = ks[max(0, i - 1):i + 2]
    else:
        lo, hi = (0.12, 0.18) if rule == "oi-12-18" else (0.10, 0.20)
        pool = [c for c in cands if lo <= abs(c[3]) <= hi]
    pool = [c for c in pool if ok(c) and RB.oi(date, c[0]) is not None]
    if not pool: return None, None
    pick = max(pool, key=lambda c: RB.oi(date, c[0]))
    how = "same" if pick[0] == best[0] else ("new" if not ok(best) else "moved")
    return pick, how


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], float(t["price"]))
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    walked, out = {}, []
    for rule in RULES:
        c, how = choose(cands, floor, rule, t["date"])
        if not c: continue
        if c[0] not in walked:
            sim.X.clear(); sim.X.update(CHAMP)
            cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], c[0], c[1], CAL)
            if cost is None: walked[c[0]] = None; continue
            rcost, real = OS.price(steps, c[0], cost, "bid")
            fills = [s for s in steps if s[2] in ("buy", "sell")]
            row = dict(r1=sim.result(rcost, real, 0.01), r05=sim.result(rcost, real, 0.005), cov=int(all(RB.quote(c[0], s[0], max(s[1] - 1, 0)) for s in fills)),
                       delta=round(abs(c[3]), 3), oi=RB.oi(t["date"], c[0]))
            if kind == "main":
                sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
                held = {}
                for mm in range(m0, 390):
                    k = RB.quote(c[0], t["date"], mm)
                    held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
                row["held"] = held
            walked[c[0]] = row
        if not walked[c[0]]: continue
        out.append(dict(src=src, kind=kind, rule=rule, how=how, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
                        d2=int(float(t.get("c_t") or 9) < 1.8), **walked[c[0]]))
    return out


def entries(R, src, rule, part, a="", z="9"):
    main = [r for r in R if r["src"] == src and r["kind"] == "main" and r["rule"] == rule and half(r["date"]) == part and a <= r["date"] <= z]
    adds = {}
    for r in R:
        if r["src"] == src and r["kind"] == "add" and r["rule"] == rule: adds.setdefault((r["date"], r["sym"], r["right"]), []).append(r)
    E = []
    for r in main:
        E.append((r["date"], r["minute"], 1.0, r["r1"], r["sym"], r["how"], r["cov"]))
        if not r["d2"]: continue
        for x in sorted(adds.get((r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if x["minute"] <= r["minute"]: continue
            share, up = r["held"].get(x["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((x["date"], x["minute"], 0.5, x["r05"], x["sym"], x["how"], x["cov"]))
            break
    return E


def stats(E):
    R = sorted(E)
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[3]))) for e in R]
    acct, dd = account(pnl)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top])
    moved = [e for e in R if e[5] != "same"]
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), moved=sum(e[5] == "moved" for e in R), new=sum(e[5] == "new" for e in R),
                moved_pnl=round(sum(1e4 * e[2] * max(-1, e[3]) for e in moved)), cov=round(sum(e[6] for e in R) / max(1, len(R)), 3))


def main():
    S = {"fair": (fe.fair_signals("sg_c12_15"), fe.fair_signals("s_t18r15")), "fav": (FR.signals("25"), FR.signals("24"))}
    jobs = [(src, kind, t) for src, (m, a) in S.items() for kind, T in (("main", m), ("add", a)) for t in T]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for rows in pool.map(one, jobs, chunksize=4) for r in rows]
    out = {}
    print("\n### Tune weeks (picking), real quotes, 1% from $100,000\n")
    print("| Rule | Fair list | Favorites 24m | Without the best 5 (fair / fav) | Trades moved / new (fair) | Their P&L at $10K (fair) | Fully on the book |\n|---|---|---|---|---|---|---|")
    for rule in RULES:
        f, v = stats(entries(R, "fair", rule, "tune")), stats(entries(R, "fav", rule, "tune", FR.A24))
        out[f"tune|{rule}"] = dict(fair=f, fav=v)
        print(f"| {rule} | ${f['acct']:,} / {f['dd']:.0%} ({f['trades']}) | ${v['acct']:,} / {v['dd']:.0%} ({v['trades']}) | ${f['no5']:,} / ${v['no5']:,} | "
              f"{f['moved']} / {f['new']} | {f['moved_pnl']:+,} | {f['cov']:.0%} / {v['cov']:.0%} |", flush=True)
    base = out["tune|now"]
    score = lambda r: min(out[f"tune|{r}"]["fair"]["acct"] / base["fair"]["acct"], out[f"tune|{r}"]["fav"]["acct"] / base["fav"]["acct"])
    best = max(RULES[1:], key=score)
    print(f"\nPicked on tune: {best} (the best of the worse of the two lists against now); better than now on tune: {score(best) > 1}\n")
    print("### Check weeks, one run\n\n| Rule | Fair list | Favorites 24m | Without the best 5 (fair / fav) |\n|---|---|---|---|")
    for rule in ("now", best):
        f, v = stats(entries(R, "fair", rule, "check")), stats(entries(R, "fav", rule, "check", FR.A24))
        out[f"check|{rule}"] = dict(fair=f, fav=v)
        print(f"| {rule} | ${f['acct']:,} / {f['dd']:.0%} | ${v['acct']:,} / {v['dd']:.0%} | ${f['no5']:,} / ${v['no5']:,} |", flush=True)
    out["best"] = best
    json.dump(out, open(f"{B}/oi_strike_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
