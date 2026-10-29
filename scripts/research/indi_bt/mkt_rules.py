"""The market's day at entry (the user, 2026-10-29, after calls on red days and puts on green days were found to almost
never become giants: "does calls in a red days ends in giant? and the oposite?", then "when it big red or big green -
lower the treshold needed to enter", and "run only on the tune. only candidate from each combination go with the check").

On the champion of retry_roll.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes). sm = SPY's move from the day
before's close to the signal minute, on the trade's side (what the bot knows at entry). Set before running:
  filter   filter-50        skip a call when SPY is down >= 0.5%, a put when SPY is up >= 0.5%
           filter-50-half   the same at half size
           filter-50-noD2   filter-50, but a D2 entry (t < 1.8: the stock holding up on SPY's bad minutes) is kept
  lower    lower-50         defence_signals.py m5_12: the champion's rule, or t >= 1.2 (volume >= 1.5x) when SPY has
                            moved >= 0.5% with the side
  both     both-50          lower-50 + filter-50          both-30   m3_12 + filter at 0.3%
           both-100         m10_12 + filter at 1%          both-50-t10   m5_10 (t >= 1.0) + filter-50
  control  the champion's rule rebuilt the same way (defence_signals.py c12_15, suffix _mk): must match the champion
Every version on the tune weeks; each idea's pick (min(fair, Favorites) money vs the champion at 2%) and the champion
then on the check weeks, in the same run (the other versions get no check numbers). Fair list + Favorites (favorites.txt,
24 months), 2% and 3%; the giants, the median and the rest of the changed trades. Real quotes: MK_PASS=list ->
open10_dbx_list.csv, dbx_fetch.py open10.

  BT_RULES=c12_15,m5_12,m3_12,m10_12,m5_10 BT_SIG_SUFFIX=_mk BT_SPAN_END=2026-10-23 BT_SYMS=... defence_signals.py, then
  node --env-file=.env <dir>/run.mjs mkt_rules.py (MK_PASS=list first, then dbx_fetch.py open10)   (from the app repo root)
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
from split import half
from store import day

B = "data/local/x/bt"
SIZES = rr.SIZES
Z = FR.Z
LISTING = os.environ.get("MK_PASS") == "list"
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open5", "open7", "open8", "open9", "open10")]
V = {"champion": ("base", None, None), "control": ("c12_15", None, None),
     "filter-50": ("base", 0.005, "skip"), "filter-50-half": ("base", 0.005, "half"), "filter-50-noD2": ("base", 0.005, "skip-noD2"),
     "lower-50": ("m5_12", None, None),
     "both-50": ("m5_12", 0.005, "skip"), "both-30": ("m3_12", 0.003, "skip"), "both-100": ("m10_12", 0.01, "skip"), "both-50-t10": ("m5_10", 0.005, "skip")}
IDEAS = (("filter", ("filter-50", "filter-50-half", "filter-50-noD2")), ("lower", ("lower-50",)), ("both", ("both-50", "both-30", "both-100", "both-50-t10")))


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
    T = [dict(r, status="ok") for f in glob.glob(f"{B}/s_sig_{rule}_mk_20*.csv") for r in csv.DictReader(open(f))]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    return {"fair": [t for t in T if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST],
            "fav": [t for t in T if t["sym"] in FR.FAV and FR.A24 <= t["date"] <= Z]}


def spy_move(date, minute, right):
    i = rr.CAL.index(date); prev = day("SPY", rr.CAL[i - 1])
    c = rr.closes("SPY", date)
    now = next((c[k] for k in range(min(minute, 389), -1, -1) if c[k]), None)
    if not prev or not now: return 0.0
    return (1 if right == "C" else -1) * (now / prev[-1][4] - 1)


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
    return dict(src=src, date=date, sym=sym, right=right, minute=m0, d2=int(float(t.get("c_t") or 9) < 1.8), sm=spy_move(date, m0, right),
                r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                over=int(any(s[0] != date for s in sells)), held=held, book=bk)


def key(src, t): return (src, t["date"], t["sym"], t["right"], int(t["minute"]))


def main():
    base = {"fair": fe.fair_signals("sg_c12_15"), "fav": FR.signals("25")}
    adds = {"fair": fe.fair_signals("s_t18r15"), "fav": FR.signals("24")}
    sets = {"base": base, **{r: rule_signals(r) for r in {v[0] for v in V.values()} if r != "base"}}
    for name, S in sets.items(): print(f"signals {name}: fair {len(S['fair'])}, fav {len(S['fav'])}", flush=True)
    days = {name: {src: {} for src in base} for name in sets}   # the first signal of each stock-day
    for name, S in sets.items():
        for src in base:
            for t in sorted(S[src], key=lambda t: int(t["minute"])): days[name][src].setdefault((t["date"], t["sym"]), t)
    W = {}

    def run(parts, versions, with_adds):
        jobs = {}
        for v in versions:
            for src, d in days[V[v][0]].items():
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
        with open(os.path.join(HERE, "open10_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{n} walks; {len(rows)} contracts on {len({x[0] for x in rows})} days -> open10_dbx_list.csv"); return
    A = collections.defaultdict(list)

    def index_adds():
        A.clear()
        for k, w in W.items():
            if k[0] == "add" and w: A[(w["src"], w["date"], w["sym"], w["right"])].append(w)

    def entries(v, src, part, size, a=""):
        sig, lvl, mode = V[v]; E = []
        for (date, sym), t in days[sig][src].items():
            if half(date) != part or date < a: continue
            x = W.get(key(src, t))
            if not x: continue
            k, ret = 1.0, x["r"][size]
            if lvl is not None and x["sm"] <= -lvl:
                if mode == "skip" or (mode == "skip-noD2" and not x["d2"]): continue
                if mode == "half": k, ret = 0.5, x["h"][size]
            E.append((date, x["minute"], k, ret, x["over"]))
            if not x["d2"]: continue
            for ad in sorted(A.get((src, date, sym, x["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= x["minute"]: continue
                share, up = x["held"].get(ad["minute"], (0, None))
                if share > 0 and up is not None and up > 0: E.append((date, ad["minute"], 0.5 * k, ad["h"][size], ad["over"]))   # the add at half the trade's weight (its cap at half size)
                break
        return E

    L = (("fair", ""), ("fav", FR.A24))
    print(run(("tune",), list(V), True), "tune walks", flush=True); index_adds()
    out = {(s, "tune", v): [rr.stats(entries(v, src, "tune", s, a), s) for src, a in L] for s in SIZES for v in V}
    b = out[(0.02, "tune", "champion")]
    picks = {}
    for name, group in IDEAS:
        sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
        picks[name] = max(group, key=sc)
    print(run(("check",), ["champion"] + list(picks.values()), True), "check walks (the champion and the picks only)", flush=True); index_adds()
    for v in ["champion"] + list(picks.values()):
        for s in SIZES: out[(s, "check", v)] = [rr.stats(entries(v, src, "check", s, a), s) for src, a in L]
    for size in SIZES:
        print(f"\n#### {size:.0%}, the tune weeks, every version (end / worst drop)\n\n| Version | Tune fair | Tune fav | Without best 5 (fair / fav) | Trades (fair / fav) |\n|---|---|---|---|---|")
        for v in V:
            tf, tv = out[(size, "tune", v)]
            mark = " 🎯" if v in picks.values() else ""
            print(f"| {v}{mark} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${tf['no5']:,} / ${tv['no5']:,} | {tf['trades']} / {tv['trades']} |", flush=True)
        print(f"\n#### {size:.0%}, the check weeks: the champion and each idea's pick\n\n| Version | Check fair | Check fav | Without best 5 (fair / fav) | Trades (fair / fav) |\n|---|---|---|---|---|")
        for v in ["champion"] + list(picks.values()):
            cf, cv = out[(size, "check", v)]
            print(f"| {v} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | ${cf['no5']:,} / ${cv['no5']:,} | {cf['trades']} / {cv['trades']} |", flush=True)
    for name, v in picks.items():
        print(f"\nPick ({name}): {v} 🎯", flush=True)
    # the trades the picks change, fair list, at $10K: added / removed stock-days and their giants, medians
    print("\n#### What each pick changes (fair list, $10K at 2% returns)\n\n| Pick | Half | Removed or halved: n, sum, giants, median | Added: n, sum, giants, median |\n|---|---|---|---|")
    for name, v in picks.items():
        sig, lvl, mode = V[v]
        for part in ("tune", "check"):
            removed = [W[key("fair", t)] for (d, s), t in days["base"]["fair"].items() if half(d) == part and W.get(key("fair", t))
                       and lvl is not None and W[key("fair", t)]["sm"] <= -lvl and not (mode == "skip-noD2" and W[key("fair", t)]["d2"])]
            added = [W[key("fair", t)] for k, t in days[sig]["fair"].items() if half(k[0]) == part and k not in days["base"]["fair"] and W.get(key("fair", t))
                     and not (lvl is not None and W[key("fair", t)]["sm"] <= -lvl)]
            f = lambda X: (lambda u: f"{len(u)}, {sum(u):+,.0f}, {sum(a >= 3e4 for a in u)}, {st.median(u) if u else 0:+,.0f}")([1e4 * max(-1, x["r"][0.02]) for x in X])
            print(f"| {v} | {part} | {f(removed)} | {f(added)} |", flush=True)
    bk = [w["book"] for w in W.values() if w]
    print(f"fills on the real book: {sum(bk) / max(1, len(bk)):.0%}")
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/mkt_rules_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
