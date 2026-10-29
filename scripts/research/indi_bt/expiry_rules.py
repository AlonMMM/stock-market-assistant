"""Three expiry rules (the user, 2026-10-29, /new-test: "couple of test on the tune - if tomorrow is friday, and you do
find 0.2$ or more - go to next week; if its friday - try 0DTE; if this is the last trading day (can't overnight) try to
cut winnings during the day").

On the champion of retry_roll.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes; picks the 0.15-delta option of
the nearest expiry 1-7 days out, $0.20 / 200 contracts; holds overnight from +50% only with 2+ days to expiry). Set
before running, each idea picked on tune by min(fair, Favorites) money:
  1. Thursday entries (tomorrow is Friday)
     thu-next     the nearest expiry 2-10 days out instead of tomorrow's, when its 0.15-delta option passes the
                  champion's pick ($0.20, 200 contracts); else tomorrow's as now
     thu-next-fb  tomorrow's as now; the 2-10 day expiry only when tomorrow's finds no contract (the other reading)
  2. Friday entries
     fri-0dte-15  today's expiry (0DTE) at delta 0.15 when it passes the pick, else as now; sold by 15:30 as any
                  expiry day
     fri-0dte-25  the same at delta 0.25 (a 0.15 option expiring today is often under $0.20)
  3. A day the position cannot be held tonight (under carry_min_dte = 2 days to expiry; sim.py nocarry_trail)
     nc-50-30     once up +50% over the cost, all out 30% under the option's high
     nc-100-30    from +100%, 30%            nc-50-20   from +50%, 20%
One run, tune AND check (split.py), fair list + Favorites (favorites.txt, 24 months), 2% and 3%; the giants, the median
and the rest of the changed trades. Real quotes: EX_PASS=list -> open9_dbx_list.csv (the new contracts), dbx_fetch.py
open9 -> dbx_cache/open9; the book reads every cache.

  node --env-file=.env <dir>/run.mjs expiry_rules.py (EX_PASS=list first, then dbx_fetch.py open9)   (from the app repo root)
"""
import collections, csv, datetime as dt, gzip, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from d2_failed_break import CHAMP
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
LISTING = os.environ.get("EX_PASS") == "list"
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open5", "open7", "open8", "open9")]
VERSIONS = {"champion": ("base", CHAMP),
            "thu-next": ("thu-next", CHAMP), "thu-next-fb": ("thu-next-fb", CHAMP),
            "fri-0dte-15": ("fri-0dte-15", CHAMP), "fri-0dte-25": ("fri-0dte-25", CHAMP),
            "nc-50-30": ("base", {**CHAMP, "nocarry_trail": {"arm": 0.5, "trail": 0.3}}),
            "nc-100-30": ("base", {**CHAMP, "nocarry_trail": {"arm": 1.0, "trail": 0.3}}),
            "nc-50-20": ("base", {**CHAMP, "nocarry_trail": {"arm": 0.5, "trail": 0.2}})}
IDEAS = (("1. Thursday -> next week", ("thu-next", "thu-next-fb")), ("2. Friday -> 0DTE", ("fri-0dte-15", "fri-0dte-25")),
         ("3. Lock gains when it cannot be held tonight", ("nc-50-30", "nc-100-30", "nc-50-20")))


def book(date):
    """real_bench.book over the list's cache, the other list's and the extra fetches."""
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
BASE_EXPIRY = sim.expiry_for


def expiry_in(und, date, lo, hi):
    """The nearest listed expiry lo-hi calendar days after date (this month's and next month's listings)."""
    d0 = dt.date.fromisoformat(date)
    first = d0.replace(day=1); nxt = (first + dt.timedelta(days=32)).replace(day=1)
    out = set()
    for m0 in (first, nxt):
        k = (und, m0.isoformat()[:7])
        if k not in sim._exp: sim._exp[k] = sim.expiries(und, m0.isoformat(), (m0 + dt.timedelta(days=40)).isoformat())
        out |= set(sim._exp[k])
    a, b = (d0 + dt.timedelta(days=lo)).isoformat(), (d0 + dt.timedelta(days=hi)).isoformat()
    return next((e for e in sorted(out) if a <= e <= b), None)


def prefetch(sym, date, right, price, exp):
    """The option bars of the strikes the picker scans for this expiry (the bar store has only the contracts picked
    before): one download per stock, day, side and expiry, cached by store.fetch_bars."""
    call = right == "C"
    ks = [k for k in sim.chain(sym, exp, right) if (price <= k <= price * (1 + sim.C["otm_scan_max"]) if call else price * (1 - sim.C["otm_scan_max"]) <= k <= price)]
    ks = sorted(ks, key=lambda k: abs(k - price))[:sim.C["max_strikes"]]
    syms = [sim.occ(sym, exp, k, right) for k in ks]
    if syms:
        try: sim.fetch_bars("options", syms, date, date, key=f"exr|{sym}|{date}|{right}|{exp}")
        except Exception: pass


def pick_with(sym, date, m, right, price, lo, hi, target=0.15):
    exp = expiry_in(sym, date, lo, hi)
    if not exp: return None
    prefetch(sym, date, right, price, exp)
    sim.expiry_for = lambda und, d: exp
    try: return rr.pick(sym, date, m, right, price, target)
    finally: sim.expiry_for = BASE_EXPIRY


def pick(mode, sym, date, m, right, price):
    wd = dt.date.fromisoformat(date).weekday()
    base = lambda: rr.pick(sym, date, m, right, price)
    if mode == "thu-next" and wd == 3: return pick_with(sym, date, m, right, price, 2, 10) or base()
    if mode == "thu-next-fb" and wd == 3: return base() or pick_with(sym, date, m, right, price, 2, 10)
    if mode.startswith("fri-0dte") and wd == 4:
        return pick_with(sym, date, m, right, price, 0, 0, 0.15 if mode.endswith("15") else 0.25) or base()
    return base()


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8), v={})
    picks = {}
    for v, (mode, ex) in VERSIONS.items():
        if kind == "add" and v != "champion": continue
        if mode not in picks: picks[mode] = pick(mode, sym, date, m0, right, float(t["price"]))
        c = picks[mode]
        if not c: continue
        if LISTING:
            if c != picks.get("base", c): out.setdefault("want", []).append((date, c[0], max(m0 - 2, 0)))
            continue
        g = rr.leg(sym, date, m0, right, c, ex)
        if not g: continue
        rcost, real, bk = g
        sells = [s for s in real if s[2] == "sell"]
        r = dict(r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                 over=int(any(s[0] != date for s in sells)), contract=c[0], book=bk, exits=collections.Counter(s[5] for s in sells))
        if kind == "main":
            held = {}
            for mm in range(m0, 390):
                q = RB.quote(c[0], date, mm)
                held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
            r["held"] = held
        out["v"][v] = r
    return out


def entries(R, adds, src, v, part, size, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x = r["v"][v]
        E.append((r["date"], r["minute"], 1.0, x["r"][size], x["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"] or "champion" not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["v"]["champion"]["h"][size], ad["v"]["champion"]["over"]))
            break
    return E


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", "main", t) for t in FR.signals("25")]
    if not LISTING: jobs += [("fair", "add", t) for t in fe.fair_signals("s_t18r15")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    if LISTING:
        rows = sorted({w for r in R for w in r.get("want", [])})
        with open(os.path.join(HERE, "open9_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{len(rows)} new contracts on {len({x[0] for x in rows})} days -> open9_dbx_list.csv"); return
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    M = [r for r in R if r["kind"] == "main"]
    L = (("fair", ""), ("fav", FR.A24))
    out = {(s, p, v): [rr.stats(entries(R, adds, src, v, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in VERSIONS}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) | Trades tune (fair / fav) |\n|---|---|---|---|---|---|---|---|")
        for v in VERSIONS:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} | {tf['trades']} / {tv['trades']} |", flush=True)
    b = out[(0.02, "tune", "champion")]
    for name, group in IDEAS:
        sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
        best = max(group, key=sc)
        bc, pc = out[(0.02, "check", "champion")], out[(0.02, "check", best)]
        print(f"\nPicked on tune ({name}): {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
              f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}", flush=True)
    # the changed trades of each version, per half: how many, giants, the median and the rest, against the champion's same trades
    print("\n#### The trades each version changes (fair list), at $10K (2% returns): count; this version's sum (giants) vs the champion's; median; the rest\n\n| Version | Tune | Check |\n|---|---|---|")
    for v in VERSIONS:
        if v == "champion": continue
        cells = []
        for part in ("tune", "check"):
            ch = [(r["v"][v], r["v"].get("champion")) for r in M if r["src"] == "fair" and half(r["date"]) == part and v in r["v"]
                  and (r["v"][v]["contract"] != (r["v"].get("champion") or {}).get("contract") or abs(r["v"][v]["r"][0.02] - (r["v"].get("champion") or {"r": {0.02: 9e9}})["r"][0.02]) > 1e-6)]
            a = [1e4 * max(-1, x["r"][0.02]) for x, _ in ch]; c0 = [1e4 * max(-1, y["r"][0.02]) for _, y in ch if y]
            g = [z for z in a if z >= 3e4]
            cells.append(f"{len(ch)}; {sum(a):+,.0f} ({len(g)} giants) vs {sum(c0):+,.0f}; median {st.median(a) if a else 0:+,.0f}; rest {sum(a) - sum(g):+,.0f}")
        print(f"| {v} | {cells[0]} | {cells[1]} |", flush=True)
    for v in ("nc-50-30", "thu-next", "fri-0dte-25"):
        ex = sum((r["v"][v]["exits"] for r in M if r["src"] == "fair" and v in r["v"] and half(r["date"]) == "tune"), collections.Counter())
        print(f"exits, tune, fair, {v}: " + ", ".join(f"{k} {n}" for k, n in ex.most_common(8)))
    bk = [r["v"][v]["book"] for r in M for v in VERSIONS if v in r["v"] and v != "champion" and r["v"][v]["contract"] != (r["v"].get("champion") or {}).get("contract")]
    print(f"new contracts' fills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/expiry_rules_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
