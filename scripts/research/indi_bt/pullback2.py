"""The opening, not on the spike: the industry's ways (the user, 2026-10-28: "the openning not buy on the spike might be
intersting to go deep. Can you check how it is done in the industry? Waiting to pull back than to compermation/ buy on a
suport"; then "Yes" to A-D). pullback.py's percentage pullback lost tune and won check; these wait for a LEVEL instead,
and keep the runaway days with a breakout fallback.

On the champion of retry_roll.py, opening signals only (m0 = 10, 09:40 New York) after a big clean move (pullback.py:
the 10 minutes before >= 2x the stock's usual move for those minutes, no give-back over 20% inside them). Levels, on the
bet's side (a put is the mirror): VWAP (from 09:30, (high + low + close) / 3 weighted by volume); the 5-minute opening
range high ORH5 (09:30-09:34); the 10-minute range high ORH10 / low ORL10 (09:30-09:39). Window: 20 minutes from m0.
"Back" always needs the day's t vs SPY x beta > 0.5 (the strength exit would sell at once otherwise).
  A  vwap      wait for a bar that touches VWAP, buy at the first close back above it; if the stock first closes above
               ORH10 + 10% of the 10-minute range (it never pulled back), buy that breakout; neither in 20 minutes: skip
  A0 vwap-skip the same without the breakout (the control)
  B  retest    wait for a bar that comes back to ORH5 (low <= ORH5), buy at the first close above the bar before's high
               while the close holds ORH5; the same breakout fallback
  C  half      half a size at m0 (as now), half at A's entry (none when A finds none)
  D  type      A only when the open was not a drive (by m0 the stock traded back through the opening price, against
               the bet); a drive open is bought at m0 as now (Market Profile's "do not fade an open drive")
One run, tune AND check (split.py), fair list + Favorites 24m, 2% and 3%, picked on tune by min(fair, Favorites) money.
Real quotes: the new entries' contracts are fetched first (PB2_PASS=list -> open2_dbx_list.csv; dbx_fetch.py open2 ->
dbx_cache/open2/), and the book reads both caches; the share of fills on the book is printed.

  PB2_PASS=list node --env-file=.env <dir>/run.mjs pullback2.py; node --env-file=.env <dir>/run.mjs dbx_fetch.py open2;
  node --env-file=.env <dir>/run.mjs pullback2.py      (from the app repo root)
"""
import collections, csv, gzip, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import pullback as pb
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half
from store import day

B = "data/local/x/bt"
SIZES = rr.SIZES
EXTRA = os.path.join(HERE, "dbx_cache", "open2")
LISTING = os.environ.get("PB2_PASS") == "list"
W = 20
VERSIONS = ("vwap", "vwap-skip", "retest", "half", "type")


def book(date):
    """real_bench.book over both caches: the list's own (fair / Favorites) and open2."""
    if date not in RB.Q:
        if len(RB.Q) > 3: RB.Q.clear()
        by = {}
        for d in (RB.DBX, EXTRA):
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


def levels(sym, date):
    bars = {b[0]: b for b in day(sym, date)}
    vwap = [None] * 390; pv = vol = 0.0
    for m in range(390):
        b = bars.get(m)
        if b and b[5]: pv += (b[2] + b[3] + b[4]) / 3 * b[5]; vol += b[5]
        vwap[m] = pv / vol if vol else None
    return bars, vwap


def entry(v, c, bars, vwap, ts, m0, bet):
    """The buy minute of version v, None to skip."""
    o = bars.get(0)
    r10 = [bars[m] for m in range(0, 10) if m in bars]
    r5 = [bars[m] for m in range(0, 5) if m in bars]
    if not o or len(r10) < 5 or len(r5) < 3: return m0
    hi10 = max(b[2] for b in r10) if bet > 0 else min(b[3] for b in r10)
    lo10 = min(b[3] for b in r10) if bet > 0 else max(b[2] for b in r10)
    orh5 = max(b[2] for b in r5) if bet > 0 else min(b[3] for b in r5)
    brk = hi10 + 0.1 * (hi10 - lo10)
    if v == "type":
        through = any((b[3] < o[1]) if bet > 0 else (b[2] > o[1]) for b in r10)
        if not through: return m0
        v = "vwap"
    touched = False
    for m in range(m0 + 1, min(m0 + W, 374) + 1):
        b = bars.get(m)
        if not b or ts[m] is None: continue
        low, high, close = (b[3], b[2], b[4]) if bet > 0 else (-b[2], -b[3], -b[4])
        if v in ("vwap", "vwap-skip"):
            lv = vwap[m] * bet if vwap[m] else None
            if lv is None: continue
            if not touched:
                if low <= lv: touched = True; continue
                if v == "vwap" and close > brk * bet and ts[m] > 0.5: return m
                continue
            if close > lv and ts[m] > 0.5: return m
        else:   # retest of ORH5
            lv = orh5 * bet
            if not touched:
                if low <= lv: touched = True; continue
                if close > brk * bet and ts[m] > 0.5: return m
                continue
            pb_ = bars.get(m - 1)
            prev_high = (pb_[2] if bet > 0 else -pb_[3]) if pb_ else None
            if prev_high is not None and close > prev_high and close >= lv and ts[m] > 0.5: return m
    return None


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    if LISTING:
        if kind != "main" or m0 != 10: return None
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8), v={}, want=[])
    if not LISTING:
        base = pb.walk(sym, date, m0, right, float(t["price"]))
        if not base: return None
        out["v"]["base"] = base
    if kind == "add" or m0 != 10: return out
    bet = 1 if right == "C" else -1
    c = rr.closes(sym, date)
    if not c[m0] or not c[m0 - 10]: return out
    mv = bet * (c[m0] / c[m0 - 10] - 1); u = pb.usual_move(sym, date, m0)
    if not u or mv <= 0 or mv / u < 2: return out
    run = c[m0 - 10]; worst = 0.0
    for m in range(m0 - 9, m0 + 1):
        if not c[m]: continue
        if (c[m] - run) * bet > 0: run = c[m]
        worst = max(worst, (run - c[m]) * bet)
    seen = [x for x in c[m0 - 10:m0 + 1] if x]
    total = (max(seen) - c[m0 - 10]) if bet > 0 else (c[m0 - 10] - min(seen))
    if not (total > 0 and worst <= pb.CLEAN * total): return out
    bars, vwap = levels(sym, date)
    ts = pb.tseries(sym, date, bet)
    out["hit"] = True
    for v in VERSIONS:
        m = entry(v, c, bars, vwap, ts, m0, bet)
        if v == "half": m = entry("vwap", c, bars, vwap, ts, m0, bet)
        if m is None or (m == m0 and v != "half"): out["v"][v] = None if m is None else "base"; continue
        if LISTING:
            p = rr.pick(sym, date, m, right, c[m])
            if p: out["want"].append((date, p[0], max(m - 2, 0)))
            continue
        out["v"][v] = pb.walk(sym, date, m, right, c[m])
    return out


def entries(R, adds, src, v, part, size, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        base = r["v"]["base"]
        x = r["v"].get(v, "base") if v != "base" else "base"
        legs = []
        if v == "half" and v in r["v"]:
            legs = [(base, 0.5)] + ([(x, 0.5)] if x not in (None, "base") else [])
        elif x is None: continue
        else: legs = [(base if x == "base" else x, 1.0)]
        first = legs[0][0]
        for leg, w in legs: E.append((r["date"], leg["minute"], w, leg["r"][size], leg["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= first["minute"]: continue
            share, up = first["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["v"]["base"]["h"][size], ad["v"]["base"]["over"]))
            break
    return E


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", "main", t) for t in FR.signals("25")]
    if not LISTING:
        jobs += [("fair", "add", t) for t in fe.fair_signals("s_t18r15")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    if LISTING:
        rows = sorted({w for r in R for w in r["want"]})
        with open(os.path.join(HERE, "open2_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{sum(1 for r in R if r.get('hit'))} opening signals after a big clean move; {len(rows)} contracts to fetch on "
              f"{len({x[0] for x in rows})} days -> open2_dbx_list.csv")
        return
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    M = [r for r in R if r["kind"] == "main"]
    L = (("fair", ""), ("fav", FR.A24))
    V = ["base", *VERSIONS]
    out = {(s, p, v): [rr.stats(entries(R, adds, src, v, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in V}
    for src, a in L:
        H = [r for r in M if r["src"] == src and r.get("hit") and r["date"] >= a]
        print(f"{src}: {len(H)} opening signals after a big clean move; " + "; ".join(
            f"{v}: later {sum(isinstance(r['v'].get(v), dict) for r in H)}, at 09:40 {sum(r['v'].get(v) == 'base' for r in H)}, skipped {sum(r['v'].get(v, 0) is None for r in H)}"
            for v in VERSIONS), flush=True)
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) |\n|---|---|---|---|---|---|---|")
        for v in V:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} |", flush=True)
    b = out[(0.02, "tune", "base")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max(VERSIONS, key=sc)
    bc, pc = out[(0.02, "check", "base")], out[(0.02, "check", best)]
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
          f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}")
    bk = [r["v"][v]["book"] for r in M for v in VERSIONS if isinstance(r["v"].get(v), dict)]
    print(f"new entries' fills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    for v in ("vwap", "type"):
        print(f"\n### {v}: the changed trades (tune, 2%, fair list): date sym side | buy | champion -> this")
        for r in sorted((r for r in M if r["src"] == "fair" and half(r["date"]) == "tune" and r.get("hit") and r["v"].get(v) != "base"), key=lambda r: r["date"]):
            x = r["v"].get(v)
            got = "skipped" if x is None else f"m{x['minute']} {x['r'][0.02]:+.0%}"
            print(f"  {r['date']} {r['sym']} {r['right']} | {got} | {r['v']['base']['r'][0.02]:+.0%}", flush=True)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/pullback2_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
