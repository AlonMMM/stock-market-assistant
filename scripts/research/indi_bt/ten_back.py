"""Back on the watchlist at 10:00 after an early thin skip (the user, 2026-10-30, after open_window.py: "what about - if 1540
skip, return the stock gain at 1600 (isr time)"; this week Israel is NY+6, so 9:40 -> 10:00 NY, when the 30-minute volume
window is full again).

On the champion (retry_roll.py base: 2.5 + IBIT $0.10 + the pyramid, real quotes), a main signal before 10:00 whose pick is
thin (price over the floor, volume under 200) ends the stock's day. Set before running:
  ten_same    from 10:00, the first minute (to 15:44) where the champion's rule holds on the same side and the pick is liquid
  ten_any     the same, either side
  ten_same30  ten_same, only 10:00-10:30
One trade a stock a day; the new trade gets the champion's exits, no pyramid add. One run, tune AND check (split.py), fair
list + Favorites (24 months), 2% and 3%, picked on tune by min(fair, Favorites); the new trades: count, giants, median, sum.
Real quotes for the new legs: TT_PASS=list -> open20_dbx_list.csv, dbx_fetch.py open20.

  node --env-file=.env <dir>/run.mjs ten_back.py      (from the app repo root; TT_PASS=list and dbx_fetch.py open20 first)
"""
import collections, csv, gzip, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import spy_rules as SR
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from d2_failed_break import CHAMP
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
LISTING = os.environ.get("TT_PASS") == "list"
SR.VERSIONS = {"champion": CHAMP}
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open17", "open18", "open20")]
LAST = 374
VERS = ("ten_same", "ten_any", "ten_same30")


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


def thin(sym, date, m, right, price):
    """True when the champion's pick at m is over the price floor but under 200 contracts in 30 minutes."""
    cands = cu.candidates(sym, date, m, right, price)
    if not cands: return False
    b = min(cands, key=lambda c: abs(c[3] - 0.15))
    return b[4] >= (0.10 if sym == "IBIT" else 0.20) and b[5] < 200


def rule_minutes(sym, date, right):
    v = rr.ALL.get(("c12_15", sym, date, right))
    return v[0] if v else []


def try_at(sym, date, m, right):
    cl = rr.closes(sym, date)
    px = next((cl[k] for k in range(m, -1, -1) if cl[k]), None)
    if not px: return None
    return rr.pick(sym, date, m, right, px)


def walk_ten(job):
    """A thin main signal -> {version: trade or None}."""
    src, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    if rr.pick(sym, date, m0, right, float(t["price"])) or not thin(sym, date, m0, right, float(t["price"])): return None
    if m0 >= 30: return None
    found = {}
    for key, sides in (("same", (right,)), ("any", ("C", "P"))):
        for m, r in sorted((m, r) for r in sides for m in rule_minutes(sym, date, r) if 30 <= m <= LAST):
            c = try_at(sym, date, m, r)
            if c: found[key] = (m, r, c); break
    if LISTING: return [(date, x[2][0], max(x[0] - 2, 0)) for x in found.values()]
    res = {}
    for k, (m, r, c) in found.items():
        g = rr.leg(sym, date, m, r, c)
        if not g: continue
        rcost, real, bk = g
        res[k] = dict(minute=m, right=r, contract=c[0], r={s: sim.result(rcost, real, s) for s in SIZES},
                      over=int(any(s[0] != date for s in real if s[2] == "sell")), book=bk)
    out = dict(src=src, date=date, sym=sym, right=right, m0=m0, v={})
    sm = res.get("same")
    out["v"]["ten_same"] = sm
    out["v"]["ten_any"] = res.get("any")
    out["v"]["ten_same30"] = sm if sm and sm["minute"] <= 60 else None
    return out


def main():
    mains = [("fair", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25")]
    jobs = [("fair", "main", t) for _, t in mains if _ == "fair"] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for s, t in mains if s == "fav"] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(mains), "main signals", flush=True)
    with mp.Pool(8) as pool: X = [x for x in pool.map(walk_ten, mains, chunksize=4) if x]
    if LISTING:
        rows = sorted({y for x in X for y in x})
        with open(os.path.join(HERE, "open20_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{len(rows)} rows on {len({r[0] for r in rows})} days -> open20_dbx_list.csv"); return
    print(len(X), "early thin main signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(SR.one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    L = (("fair", ""), ("fav", FR.A24))

    def entries(v, src, part, size, a):
        E = SR.entries(R, adds, src, "champion", part, size, a)
        if v == "champion": return E
        for x in X:
            y = x["v"].get(v)
            if y and x["src"] == src and half(x["date"]) == part and x["date"] >= a: E.append((x["date"], y["minute"], 1.0, y["r"][size], y["over"]))
        return E
    V = ("champion",) + VERS
    out = {(s, p, v): [rr.stats(entries(v, src, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in V}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) |\n|---|---|---|---|---|---|---|")
        for v in V:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} |", flush=True)
    b = out[(0.02, "tune", "champion")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max(VERS, key=sc)
    bc, pc = out[(0.02, "check", "champion")], out[(0.02, "check", best)]
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
          f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}")
    print("\n#### The added trades ($10K a trade, 2% returns): n, won, median, sum, giants (+300%), the rest; minutes after the skip (median)\n\n| Version | Half | Fair | Favorites |\n|---|---|---|---|")
    for v in VERS:
        for part in ("tune", "check"):
            cells = []
            for src, a in L:
                Y = [(x, x["v"][v]) for x in X if x["v"].get(v) and x["src"] == src and half(x["date"]) == part and x["date"] >= a]
                u = [1e4 * max(-1, y["r"][0.02]) for _, y in Y]; g = [q for q in u if q >= 3e4]
                cells.append(f"{len(u)}, {sum(q > 0 for q in u)}, {st.median(u) if u else 0:+,.0f}, {sum(u):+,.0f}, {len(g)}, {sum(u) - sum(g):+,.0f}; "
                             f"{st.median([y['minute'] - x['m0'] for x, y in Y]) if Y else 0:.0f} min" + (f"; giants: {', '.join(x['sym'] + ' ' + x['date'] for (x, y), q in zip(Y, u) if q >= 3e4)}" if g else ""))
            print(f"| {v} | {part} | {cells[0]} | {cells[1]} |", flush=True)
    bk = [y["book"] for x in X for y in x["v"].values() if y]
    print(f"\nthin main signals: {len(X)}; new legs' fills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/ten_back_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
