"""A better D2 (the user, 2026-10-30, after ORCL 2026-10-28 read D2 5.0 on its first two shock minutes: "D2 was 5? Isnt
it extreme?", "maybe we can improve how we calculate D2? check in the industry - and suggesting", then "yes i want to fix
the D2 before the shock it is important to me. do also D2 0.5").

D2 today: the stock's excess move (stock - beta x SPY) summed over the SPY-down minutes of the last 30, in S30 units. Two
SPY-down minutes of a 1-2% jump make it 5. Industry measures of the same idea (downside beta, the downside capture ratio)
scale by the market's drop, define a down period by a threshold, and do not let one period decide. Measures
(defence_signals.py BT_D2_MODE), each at D2 >= 0.5 / 1.0 / 1.5 for the bonus entry (t >= 1.2, volume >= 1.5x; t >= 1.8
enters as always), set before running:
  today      today's D2 (today-15 = the champion's rule, rebuilt: a control)
  clip25     each minute's excess capped at +-2.5 x the stock's typical 1-minute move (S30 / sqrt 30)
  clip30     the same at 3x
  clip30hit  clip30, and the stock beat SPY x beta on >= 60% of the window's SPY-down minutes, at least 8 of them
  floor      only the minutes SPY moved >= half its typical 1-minute move against the bet
  wspy       each minute weighted by SPY's move / its typical 1-minute move (the downside capture: per unit of market drop)
On the champion of mkt_rules.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes). Every version on the tune weeks;
each measure's pick (min(fair, Favorites) money vs the champion at 2%) and the champion on the check weeks, in the same
run. Fair list + Favorites (24 months), 2% and 3%; per version the median trade, the giants (+300%), the non-giant sum,
by year; and the stock-days each pick adds, drops or moves vs the champion.

  for M in today clip25 clip30 clip30hit floor wspy: BT_D2_MODE=<mode> BT_RULES=c12_5,c12_10,c12_15 BT_SIG_SUFFIX=_df_<M>
    BT_SPAN_END=2026-10-23 BT_SYMS=<fair + Favorites> defence_signals.py; then D2F_PASS=list d2_fix.py -> open13_dbx_list.csv,
  dbx_fetch.py open13, then node --env-file=.env <dir>/run.mjs d2_fix.py      (from the app repo root; run_d2fix.sh does all)
"""
import collections, csv, glob, gzip, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import news_filter as nf
import real_bench as RB
from low_delta import HIS40, PRIOR
from score_sum import account
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
Z = FR.Z
LISTING = os.environ.get("D2F_PASS") == "list"
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open5", "open7", "open8", "open9", "open10", "open11", "open12", "open13")]
MODES = ("today", "clip25", "clip30", "clip30hit", "floor", "wspy")
LEVELS = (("05", "c12_5"), ("10", "c12_10"), ("15", "c12_15"))
V = {"champion": "base", **{f"{m}-{l}": f"{r}_df_{m}" for m in MODES for l, r in LEVELS}}
IDEAS = [(m, tuple(f"{m}-{l}" for l, _ in LEVELS)) for m in MODES]


def book(date):
    if date not in RB.Q:
        if len(RB.Q) > 3: RB.Q.clear()
        by = {}
        for d in [RB.DBX, fm.DBX["fair"], fm.DBX["fav"]] + EXTRAS:
            path = os.path.join(d, f"{date}.csv.gz")
            if not os.path.exists(path): continue
            got = {}
            for r in csv.DictReader(gzip.open(path, "rt")):
                if r["bid"] and r["ask"] and float(r["ask"]) > 0 and float(r["bid"]) > 0:
                    got.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
            for k, v in got.items(): by.setdefault(k, sorted(v))
        RB.Q[date] = by
    return RB.Q[date]


RB.book = book


def rule_signals(rule):
    T = [dict(r, status="ok") for f in glob.glob(f"{B}/s_sig_{rule}_20*.csv") for r in csv.DictReader(open(f))]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    return {"fair": [t for t in T if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST],
            "fav": [t for t in T if t["sym"] in FR.FAV and FR.A24 <= t["date"] <= Z]}




def walk(job):
    src, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    if LISTING: return (date, c[0], max(m0 - 2, 0))
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    rcost, real, bk = g
    sells = [s for s in real if s[2] == "sell"]
    held = {}
    for mm in range(m0, 390):
        q = RB.quote(c[0], date, mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
    return dict(src=src, date=date, sym=sym, right=right, minute=m0, d2=int(float(t.get("c_t") or 9) < 1.8),
                r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                over=int(any(s[0] != date for s in sells)), held=held, book=bk)


def key(src, t): return (src, t["date"], t["sym"], t["right"], int(t["minute"]))


def stats(E, size):
    """rr.stats plus the median trade, the giants (+300%), the non-giant sum and the years, each trade at $10K."""
    R = sorted(E)
    usd = [1e4 * e[2] * max(-1, e[3]) for e in R]
    pnl = [dict(date=e[0], pnl=str(u)) for e, u in zip(R, usd)]
    acct, dd = account(pnl, size)
    top = set(sorted(range(len(R)), key=lambda i: -usd[i])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], size)
    g = {i for i in range(len(R)) if R[i][3] >= 3.0}
    yrs = collections.defaultdict(float)
    for e, u in zip(R, usd): yrs[e[0][:4]] += u
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), median=round(st.median(usd)) if usd else 0,
                giants=len(g), nongiant=round(sum(u for i, u in enumerate(usd) if i not in g)), years={y: round(v) for y, v in sorted(yrs.items())})


def main():
    base = {"fair": fe.fair_signals("sg_c12_15"), "fav": FR.signals("25")}
    adds = {"fair": fe.fair_signals("s_t18r15"), "fav": FR.signals("24")}
    sets = {"base": base, **{r: rule_signals(r) for r in set(V.values()) if r != "base"}}
    for name, S in sets.items(): print(f"signals {name}: fair {len(S['fair'])}, fav {len(S['fav'])}", flush=True)
    days = {name: {src: {} for src in base} for name in sets}   # the first signal of each stock-day
    for name, S in sets.items():
        for src in base:
            for t in sorted(S[src], key=lambda t: int(t["minute"])): days[name][src].setdefault((t["date"], t["sym"]), t)
    W = {}

    def run(parts, versions, with_adds):
        jobs = {}
        for v in versions:
            for src, d in days[V[v]].items():
                for (date, sym), t in d.items():
                    if half(date) in parts and key(src, t) not in W: jobs[key(src, t)] = (src, t)
        if with_adds:
            for src in adds:
                for t in adds[src]:
                    if half(t["date"]) in parts and ("add",) + key(src, t) not in W: jobs[("add",) + key(src, t)] = (src, t)
        ks = list(jobs)
        with mp.Pool(8) as pool: W.update(zip(ks, pool.map(walk, [jobs[k] for k in ks], chunksize=4)))
        return len(ks)

    if LISTING:
        n = run(("tune", "check"), list(V), False)
        rows = sorted({w for w in W.values() if w})
        with open(os.path.join(HERE, "open13_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{n} walks; {len(rows)} contracts on {len({x[0] for x in rows})} days -> open13_dbx_list.csv"); return
    A = collections.defaultdict(list)

    def index_adds():
        A.clear()
        for k, w in W.items():
            if k[0] == "add" and w: A[(w["src"], w["date"], w["sym"], w["right"])].append(w)

    def entries(v, src, part, size, a=""):
        E = []
        for (date, sym), t in days[V[v]][src].items():
            if half(date) != part or date < a: continue
            x = W.get(key(src, t))
            if not x: continue
            E.append((date, x["minute"], 1.0, x["r"][size], x["over"]))
            if not x["d2"]: continue
            for ad in sorted(A.get((src, date, sym, x["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= x["minute"]: continue
                share, up = x["held"].get(ad["minute"], (0, None))
                if share > 0 and up is not None and up > 0: E.append((date, ad["minute"], 0.5, ad["h"][size], ad["over"]))
                break
        return E

    L = (("fair", ""), ("fav", FR.A24))
    print(run(("tune",), list(V), True), "tune walks", flush=True); index_adds()
    out = {(s, "tune", v): [stats(entries(v, src, "tune", s, a), s) for src, a in L] for s in SIZES for v in V}
    b = out[(0.02, "tune", "champion")]
    picks = {}
    for name, group in IDEAS:
        sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
        picks[name] = max(group, key=sc)
    print(run(("check",), ["champion"] + list(picks.values()), True), "check walks (the champion and the picks only)", flush=True); index_adds()
    for v in ["champion"] + list(picks.values()):
        for s in SIZES: out[(s, "check", v)] = [stats(entries(v, src, "check", s, a), s) for src, a in L]
    row = lambda v, x, y, mark="": (f"| {v}{mark} | ${x['acct']:,} / {x['dd']:.0%} | ${y['acct']:,} / {y['dd']:.0%} | ${x['no5']:,} / ${y['no5']:,} | "
                                    f"{x['trades']} / {y['trades']} | {x['median']:+,} / {y['median']:+,} | {x['giants']} · {x['nongiant']:+,} / {y['giants']} · {y['nongiant']:+,} | "
                                    + " ".join(f"{k} {v_:+,}" for k, v_ in x["years"].items()) + " |")
    head = "| Version | Fair | Favorites | Without best 5 (fair / fav) | Trades | Median at $10K | Giants · non-giant sum (fair / fav) | Fair by year at $10K |\n|---|---|---|---|---|---|---|---|"
    for size in SIZES:
        print(f"\n#### {size:.0%}, the tune weeks, every version (end / worst drop)\n\n{head}")
        for v in V: print(row(v, *out[(size, "tune", v)], " 🎯" if v in picks.values() else ""), flush=True)
        print(f"\n#### {size:.0%}, the check weeks: the champion and each measure's pick\n\n{head}")
        for v in ["champion"] + list(picks.values()): print(row(v, *out[(size, "check", v)]), flush=True)
    for name, v in picks.items(): print(f"Pick ({name}): {v} 🎯", flush=True)
    # what each pick changes on the fair list: stock-days dropped, added, or entered at another minute (at $10K, 2%)
    print("\n#### What each pick changes vs the champion (fair list, $10K, 2%; n, sum, giants, median)\n\n| Pick | Half | Dropped (champion's result) | Added | Moved: champion → pick |\n|---|---|---|---|---|")
    f = lambda u: f"{len(u)}, {sum(u):+,.0f}, {sum(x >= 3e4 for x in u)}, {st.median(u) if u else 0:+,.0f}"
    usd = lambda x: 1e4 * max(-1, x["r"][0.02])
    for name, v in picks.items():
        for part in ("tune", "check"):
            B_, P_ = days["base"]["fair"], days[V[v]]["fair"]
            ok = lambda d, k: half(k[0]) == part and W.get(key("fair", d[k]))
            drop = [usd(W[key("fair", B_[k])]) for k in B_ if ok(B_, k) and k not in P_]
            add = [usd(W[key("fair", P_[k])]) for k in P_ if ok(P_, k) and k not in B_]
            mv = [(usd(W[key("fair", B_[k])]), usd(W[key("fair", P_[k])])) for k in B_ if k in P_ and ok(B_, k) and ok(P_, k)
                  and (B_[k]["minute"], B_[k]["right"]) != (P_[k]["minute"], P_[k]["right"])]
            print(f"| {v} | {part} | {f(drop)} | {f(add)} | {f([a for a, _ in mv])} → {f([c for _, c in mv])} |", flush=True)
    json.dump({f"{s}|{p}|{v}": x for (s, p, v), x in out.items()} | {"picks": picks}, open(f"{B}/d2_fix_summary.json", "w"), indent=1)
    bk = [w["book"] for w in W.values() if w]
    print(f"fills on the real book: {sum(bk) / max(1, len(bk)):.0%}")


if __name__ == "__main__":
    main()
