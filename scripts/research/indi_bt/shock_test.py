"""Lower thresholds after a volume shock (the user, 2026-10-30: "check if a huge volume can make us enter faster. check in
the volume bot we have the shock rule which would catch the huge oracle move 2 days ago.. our bot also catch it but it
could be caught much faster. see the shock alert and if we get one - you can reduce the T V D thresholds by 30%-50%. after
you enter you need to confirm that during the next X minutes we do go through that threshold"; the ORCL example:
shock_lower.py; after d2_fix.py kept today's D2, "yes ran it").

The shock: the Volume bot's rule at 15x (f60_alerts.py F60_K=15, 10-second bars, 09:40-15:30), its side the 60-second
move's. For 30 minutes after it, on that side, the champion's rule (volume >= 1.5x and t >= 1.8, or t >= 1.2 and D2 >= 1.5)
with lower thresholds (defence_signals.py shC / shvC). A lowered entry must see the full rule within X minutes of its
signal, else what is left is sold at the bid at signal + X (no new entry that day). Set before running:
  control        the champion's rule rebuilt with the same files (c12_15): must match the champion
  cut30-cX       t, bonus t, D2 and the day volume 30% lower; X = 10 / 20 / 30
  cut50-cX       50% lower
  vol30-c20      t, bonus t, D2 30% lower and no day-volume floor (the shock is the volume); X = 20
  vol50-c20      50% lower
  cut30-c20-liq  cut30-c20, and a lowered entry whose 0.15-delta strike is illiquid takes the nearest liquid one toward the
  cut50-c20-liq  money (200+ contracts in 30 minutes, from $0.20, delta up to 0.35)
On the champion of mkt_rules.py / d2_fix.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes, D2 kept). Shocks only
where the 10-second bars are (42 of the 75 stocks from Feb 2024, 29 from Oct 2025, 4 none). Tune for every version, each
idea's pick and the champion on check, same run; 2% and 3%; medians, giants, the lowered entries and their confirmations.

  F60_K=15 F60_LAST=2159 f60_alerts.py data/local/x/bt/shocks15.json 2024-02-01 2026-10-23 <syms>
  BT_SHOCKS=... BT_RULES=c12_15,sh30,sh50,shv30,shv50 BT_SIG_SUFFIX=_sh BT_SPAN_END=2026-10-23 BT_SYMS=... defence_signals.py
  SH_PASS=list shock_test.py -> shockt_dbx_list.csv; dbx_fetch.py shockt; node --env-file=.env <dir>/run.mjs shock_test.py
"""
import collections, csv, glob, gzip, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import news_filter as nf
import real_bench as RB
from low_delta import HIS40, PRIOR
from score_sum import account, held as booked
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
Z = FR.Z
LISTING = os.environ.get("SH_PASS") == "list"
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open5", "open7", "open8", "open9", "open10", "open11", "open12", "open13", "shockt")]
CONFIRMS = (10, 20, 30)
# version -> (signal rule, confirmation minutes, liquid fallback)
V = {"champion": ("base", None, False), "control": ("c12_15_sh", None, False),
     **{f"cut{c}-c{x}": (f"sh{c}_sh", x, False) for c in (30, 50) for x in CONFIRMS},
     "vol30-c20": ("shv30_sh", 20, False), "vol50-c20": ("shv50_sh", 20, False),
     "cut30-c20-liq": ("sh30_sh", 20, True), "cut50-c20-liq": ("sh50_sh", 20, True)}
IDEAS = (("cut30", ("cut30-c10", "cut30-c20", "cut30-c30")), ("cut50", ("cut50-c10", "cut50-c20", "cut50-c30")),
         ("vol", ("vol30-c20", "vol50-c20")), ("liquid", ("cut30-c20-liq", "cut50-c20-liq")))


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






def pick(sym, date, m, right, price, liquid):
    """The champion's pick; with `liquid`, an illiquid 0.15-delta strike gives way to the nearest liquid one toward the money."""
    c = rr.pick(sym, date, m, right, price)
    if c or not liquid: return c
    cands = cu.candidates(sym, date, m, right, price)
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - 0.15))
    floor = 0.10 if sym == "IBIT" else 0.20
    ok = [c for c in cands if c[5] >= 200 and c[4] >= floor and abs(best[3]) <= abs(c[3]) <= cu.MAX_DELTA]
    if not ok: return None
    x = min(ok, key=lambda c: abs(c[3] - 0.15))
    return x[0], x[1]


def cut_at(real, date, minute, contract):
    """The real steps with what is held at `minute` of the entry day sold at the bid then; None without a quote."""
    q = RB.quote(contract, date, minute)
    if not q: return None
    keep = [s for s in real if s[0] == date and s[1] <= minute and s[2] != "carry"]
    rem = 1 - sum(s[3] for s in keep if s[2] == "sell")
    if rem > 1e-9: keep.append((date, minute, "sell", round(rem, 4), round(max(q[0], 0.01), 4), "no_confirm"))
    return keep


def walk(job):
    src, t, liquid = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    low = t.get("lowered") == "1"
    c = pick(sym, date, m0, right, float(t["price"]), liquid and low)
    if not c: return None
    if LISTING: return (date, c[0], max(m0 - 2, 0))
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    rcost, real0, bk = g
    conf = int(t["confirm"]) if t.get("confirm") not in (None, "") else None
    out = dict(src=src, date=date, sym=sym, right=right, minute=m0, d2=int(float(t.get("c_t") or 9) < 1.8), low=int(low), conf=conf, book=bk, x={})
    for x in (None,) + CONFIRMS:
        real, forced = real0, 0
        if low and x is not None and (conf is None or conf - m0 > x):
            cut = cut_at(real0, date, m0 + x, c[0])
            if cut is not None: real, forced = cut, 1
        sells = [s for s in real if s[2] == "sell"]
        held = {mm: 1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm) for mm in range(m0, 390)}
        up = {}
        for mm in range(m0, 390):
            q = RB.quote(c[0], date, mm)
            up[mm] = None if not q else (q[0] + q[1]) / 2 / rcost - 1
        out["x"][x] = dict(r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                           over=int(any(s[0] != date for s in sells)), held={mm: (held[mm], up[mm]) for mm in held}, forced=forced,
                           hd=booked(rcost, real))
    return out


def key(src, t, liquid=False): return (src, t["date"], t["sym"], t["right"], int(t["minute"]), liquid and t.get("lowered") == "1")


def stats(E, size):
    """rr.stats plus the median trade, the giants (+300%), the non-giant sum and the years, each trade at $10K."""
    R = sorted(E, key=lambda e: e[:5])
    usd = [1e4 * e[2] * max(-1, e[3]) for e in R]
    # booked on the sale day; an add's marks at its half size
    pnl = [dict(date=e[0], pnl=str(u), exit_day=e[5]["exit_day"], marks={d: e[2] * v for d, v in e[5]["marks"].items()})
           for e, u in zip(R, usd)]
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
    sets = {"base": base, **{r: rule_signals(r) for r in {v[0] for v in V.values()} if r != "base"}}
    for name, S in sets.items(): print(f"signals {name}: fair {len(S['fair'])}, fav {len(S['fav'])}", flush=True)
    days = {name: {src: {} for src in base} for name in sets}
    for name, S in sets.items():
        for src in base:
            for t in sorted(S[src], key=lambda t: int(t["minute"])): days[name][src].setdefault((t["date"], t["sym"]), t)
    W = {}

    def run(parts, versions, with_adds):
        jobs = {}
        for v in versions:
            sig, _, liq = V[v]
            for src, d in days[sig].items():
                for (date, sym), t in d.items():
                    k = key(src, t, liq)
                    if half(date) in parts and k not in W: jobs[k] = (src, t, liq)
        if with_adds:
            for src in adds:
                for t in adds[src]:
                    if half(t["date"]) in parts and ("add",) + key(src, t) not in W: jobs[("add",) + key(src, t)] = (src, t, False)
        ks = list(jobs)
        with mp.Pool(8) as pool: W.update(zip(ks, pool.map(walk, [jobs[k] for k in ks], chunksize=4)))
        return len(ks)

    if LISTING:
        n = run(("tune", "check"), list(V), False)
        rows = sorted({w for w in W.values() if w})
        with open(os.path.join(HERE, "shockt_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{n} walks; {len(rows)} contracts on {len({x[0] for x in rows})} days -> shockt_dbx_list.csv"); return
    A = collections.defaultdict(list)

    def index_adds():
        A.clear()
        for k, w in W.items():
            if k[0] == "add" and w: A[(w["src"], w["date"], w["sym"], w["right"])].append(w)

    def trade(v, src, t):
        sig, x, liq = V[v]
        w = W.get(key(src, t, liq))
        return (w, w["x"][x if w["low"] else None]) if w else (None, None)

    def entries(v, src, part, size, a=""):
        E = []
        for (date, sym), t in days[V[v][0]][src].items():
            if half(date) != part or date < a: continue
            w, x = trade(v, src, t)
            if not w: continue
            E.append((date, w["minute"], 1.0, x["r"][size], x["over"], x["hd"]))
            if not w["d2"]: continue
            for ad in sorted(A.get((src, date, sym, w["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= w["minute"]: continue
                share, up = x["held"].get(ad["minute"], (0, None))
                if share > 0 and up is not None and up > 0: E.append((date, ad["minute"], 0.5, ad["x"][None]["h"][size], ad["x"][None]["over"],
                                                                     ad["x"][None]["hd"]))
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
        print(f"\n#### {size:.0%}, the check weeks: the champion and each idea's pick\n\n{head}")
        for v in ["champion"] + list(picks.values()): print(row(v, *out[(size, "check", v)]), flush=True)
    for name, v in picks.items(): print(f"Pick ({name}): {v} 🎯", flush=True)
    # the lowered entries: how many, confirmed in time, sold unconfirmed, and what they did against the champion's day
    f = lambda u: f"{len(u)}, {sum(u):+,.0f}, {sum(x >= 3e4 for x in u)}, {st.median(u) if u else 0:+,.0f}"
    usd = lambda r: 1e4 * max(-1, r[0.02])
    print("\n#### The lowered entries (main legs, $10K, 2%; n, sum, giants, median)\n\n| Version | Half | List | Lowered | Confirmed in time | Sold unconfirmed | The champion on the same stock-days | Champion had no trade |\n|---|---|---|---|---|---|---|---|")
    for v in V:
        sig, x, liq = V[v]
        if x is None: continue
        for part in ("tune", "check") if v in picks.values() else ("tune",):
            for src, a in L:
                lo, ok, sold, ch, none = [], [], [], [], 0
                for k, t in days[sig][src].items():
                    if half(k[0]) != part or k[0] < a or t.get("lowered") != "1": continue
                    w, xx = trade(v, src, t)
                    if not w: continue
                    lo.append(usd(xx["r"]))
                    (sold if xx["forced"] else ok).append(usd(xx["r"]))
                    bt = days["base"][src].get(k)
                    bw = bt and W.get(key(src, bt))
                    if bw: ch.append(usd(bw["x"][None]["r"]))
                    else: none += 1
                print(f"| {v} | {part} | {src} | {f(lo)} | {f(ok)} | {f(sold)} | {f(ch)} | {none} |", flush=True)
    json.dump({f"{s}|{p}|{v}": x for (s, p, v), x in out.items()} | {"picks": picks}, open(f"{B}/shock_test_summary.json", "w"), indent=1)
    bk = [w["book"] for w in W.values() if w]
    print(f"fills on the real book: {sum(bk) / max(1, len(bk)):.0%}")


if __name__ == "__main__":
    main()
