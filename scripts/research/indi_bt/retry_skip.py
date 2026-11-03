"""A skipped signal stays on the list and is tried again at the next alert, on the champion 2.10 (the user, 2026-11-03:
"if we skip trade because of #4 or #5 - do not remove it from the list. do try to buy it again on the next alert").
#4 = the contract pick: thin (the 0.15-delta pick under 200 contracts in 30 minutes), too cheap (under $0.20, $0.10
IBIT), no contract (no prices / expiry). #5 (held, too small, refused by the risk rules, a broker error) never happens in
the backtest, so it is not tested here. Today a skip ends the stock's day (live and backtest). Set before running:
  champ   2.10 as is (thin_strike.py's champ: size_volume.py t3A-c5)
  RC      a main signal skipped too cheap -> at each later minute the same day where the rule holds (defence_signals.py
          BT_ALL=1 c12_15, the same side, to 15:44) pick again; the first pick over the price floor with 200 contracts
          trades
  RT      the same after a thin skip
  RB      after any #4 skip (thin, too cheap, no contract), the same side
  RBa     after any #4 skip, either side
One trade a stock a day: no retry when the stock has a champion trade that day, RBa does not retry onto a side that has
its own main signal, and two skipped signals of one stock-day keep the earliest retry. A retried trade takes 2.10's exits,
the volume tier of its signal's c_rvol (the stock's volume at the first signal: the rule-minute rows carry no rvol), D2 by
the t at the retry minute, and the pyramid add as 2.10. Prior: thin_retry.py (2026-10-30, 2.5 + IBIT + the pyramid, the old
walk): retry10/20/30, back30, both, not better (check retry30 $608,845 / $87,643 vs $929,849 / $206,879); a retry after a
too-cheap skip never. Look 2 on the thin retry (1st on the fixed walk), look 1 on too cheap.
Lists: the fair list + the Favorites (24 months); tune = even entry weeks, check = odd (split.py), the same run; one pick
on tune by min(fair, Favorites) vs champ at 2%; check for champ and the pick, at 2% and 3%.
Real quotes: RS_PASS=list writes the retried legs with no book at their entry minute -> open35_dbx_list.csv
(dbx_fetch.py open35 -> dbx_cache/open35, read by real_bench's all-folders book).

  node --env-file=.env <dir>/run.mjs retry_skip.py      (from the app repo root; RS_PASS=list and dbx_fetch.py open35 first)
-> data/local/x/bt/retry_skip_summary.json, retry_skip_added.csv
"""
import collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import thin_strike as TS   # 2.10's exits and walk, the tables
import retry_roll as rr    # the rule minutes (s_all_c12_15) and the day's closes
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half

B = "data/local/x/bt"
LISTING = os.environ.get("RS_PASS") == "list"
MODES = ("champ", "RC", "RT", "RB", "RBa")
LAST = 374   # 15:44
_pick = TS.pick


def pick(cands, floor, mode, und, right, spot):
    """Adds and the first signal: every retry version picks as the champion."""
    return _pick(cands, floor, "champ", und, right, spot)


TS.pick = pick
TS.MODES = MODES


def floor_of(sym):
    return 0.10 if sym == "IBIT" else 0.20


def best_at(sym, date, m, right, spot):
    cands = cu.candidates(sym, date, m, right, spot)
    if not cands: return None
    return min(cands, key=lambda c: abs(c[3] - 0.15))


def try_at(sym, date, m, right):
    """The champion's pick at a later rule minute, or None: (best, price)."""
    cl = rr.closes(sym, date)
    px = next((cl[k] for k in range(min(m, len(cl) - 1), -1, -1) if cl[k]), None)
    if not px: return None
    b = best_at(sym, date, m, right, px)
    if not b or b[4] < floor_of(sym) or b[5] < 200: return None
    return b, px


def rule_minutes(sym, date, right):
    v = rr.ALL.get(("c12_15", sym, date, right))
    return list(zip(*v)) if v else []


def first(job):
    """Pass 1, a main signal: the champion's pick, else the skip's reason and the first retry, same side / either side."""
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0, spot = t["sym"], t["date"], t["right"], int(t["minute"]), float(t["price"])
    b = best_at(sym, date, m0, right, spot)
    base = dict(src=src, t=t, sym=sym, date=date, right=right, m0=m0)
    if b and b[4] >= floor_of(sym) and b[5] >= 200: return dict(base, champ=b)
    reason = "none" if not b else ("cheap" if b[4] < floor_of(sym) else "thin")
    skip = dict(price=None if not b else b[4], vol=None if not b else b[5])
    same = anyside = None
    for m, tt in rule_minutes(sym, date, right):
        if m0 < m <= LAST:
            got = try_at(sym, date, m, right)
            if got: same = (m, right, tt, got[0], got[1]); break
    both = sorted((m, r, tt) for r in ("C", "P") for m, tt in rule_minutes(sym, date, r) if m0 < m <= LAST)
    for m, r, tt in both:
        if same and (m, r) == same[:2]: anyside = same; break
        got = try_at(sym, date, m, r)
        if got: anyside = (m, r, tt, got[0], got[1]); break
    return dict(base, reason=reason, skip=skip, same=same, anyside=anyside)


def legs(P):
    """Pass 1 -> each mode's retry per skipped signal, under one trade a stock a day."""
    bought = {(p["src"], p["sym"], p["date"]) for p in P if "champ" in p}
    sides = collections.defaultdict(set)
    for p in P: sides[(p["src"], p["sym"], p["date"])].add(p["right"])
    want = {"RC": ("cheap",), "RT": ("thin",), "RB": ("cheap", "thin", "none"), "RBa": ("cheap", "thin", "none")}
    out = collections.defaultdict(dict)   # (src, sym, date) -> mode -> (p, leg)
    for p in P:
        k = (p["src"], p["sym"], p["date"])
        if "champ" in p or k in bought: continue
        for mode, rs in want.items():
            if p["reason"] not in rs: continue
            g = p["anyside"] if mode == "RBa" else p["same"]
            if not g: continue
            if mode == "RBa" and g[1] != p["right"] and g[1] in sides[k]: continue
            have = out[k].get(mode)
            if have is None or g[0] < have[1][0]: out[k][mode] = (p, g)
    return out


def walk_champ(p):
    if RB.DBX != fm.DBX[p["src"]]: RB.DBX = fm.DBX[p["src"]]; RB.Q.clear(); RB.OI.clear()
    t, b = p["t"], p["champ"]
    row = TS.walk_c(t, p["m0"], b)
    if row is None: return None
    info = dict(contract=b[0], strike=b[2], delta=round(abs(b[3]), 3), price=b[4], vol30=b[5], how="pick")
    return dict(src=p["src"], kind="main", date=p["date"], minute=p["m0"], sym=p["sym"], right=p["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0),
                v={m: row for m in MODES}, pick={m: info for m in MODES})


def walk_retry(job):
    (p, g), modes = job
    if RB.DBX != fm.DBX[p["src"]]: RB.DBX = fm.DBX[p["src"]]; RB.Q.clear(); RB.OI.clear()
    m, r, tt, b, px = g
    t = dict(p["t"], minute=m, right=r, price=px, c_t=tt)
    row = TS.walk_c(t, m, b)
    if row is None: return None
    info = dict(contract=b[0], strike=b[2], delta=round(abs(b[3]), 3), price=b[4], vol30=b[5], how="retry",
                m0=p["m0"], reason=p["reason"], skip_price=p["skip"]["price"], skip_vol=p["skip"]["vol"],
                book=bool(RB.quote(b[0], p["date"], m)))
    return dict(src=p["src"], kind="main", date=p["date"], minute=m, sym=p["sym"], right=r, d2=int(tt < 1.8),
                rvol=float(p["t"].get("c_rvol") or 0), v={x: row for x in modes}, pick={x: info for x in modes})


def added(R, part, out, versions, rows_out):
    print(f"\n#### {part} weeks: the retried main trades (at $10K)\n")
    print("| Version | List | Reason | Trades | Winners | Median | Sum | Giants | Non-giant sum | Wait (median min) | Price skip -> retry (median) | Volume skip -> retry (median) | By year | Top names |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for v in versions:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            hit = [r for r in R if r["src"] == src and half(r["date"]) == part and r["date"] >= a and v in r["v"] and "champ" not in r["v"]]
            for reason in ("all", "cheap", "thin", "none"):
                h = [r for r in hit if reason == "all" or r["pick"][v]["reason"] == reason]
                if not h or (reason != "all" and len({r["pick"][v]["reason"] for r in hit}) == 1): continue
                usd = [1e4 * max(-1, r["v"][v]["r1"]) for r in h]
                g = [u for r, u in zip(h, usd) if r["v"][v]["r1"] >= 3.0]
                years, names = collections.defaultdict(float), collections.defaultdict(float)
                for r, u in zip(h, usd): years[r["date"][:4]] += u; names[r["sym"]] += u
                med = lambda xs: st.median(xs) if xs else None
                sp = med([r["pick"][v]["skip_price"] for r in h if r["pick"][v]["skip_price"] is not None])
                rp = med([r["pick"][v]["price"] for r in h])
                sv = med([r["pick"][v]["skip_vol"] for r in h if r["pick"][v]["skip_vol"] is not None])
                rv = med([r["pick"][v]["vol30"] for r in h])
                s = dict(n=len(h), win=sum(u > 0 for u in usd), median=round(st.median(usd)), sum=round(sum(usd)), giants=len(g),
                         nongiant=round(sum(usd) - sum(g)), wait=med([r["minute"] - r["pick"][v]["m0"] for r in h]),
                         skip_price=sp, retry_price=rp, skip_vol=sv, retry_vol=rv, book=round(sum(r["pick"][v]["book"] for r in h) / len(h), 3),
                         years={y: round(x) for y, x in sorted(years.items())},
                         top=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: -kv[1])[:4]],
                         bottom=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: kv[1])[:3]])
                out[f"{part}|{v}|{src}|{reason}|added"] = s
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                pr = "—" if sp is None else f"{sp:.2f} -> {rp:.2f}"
                vr = "—" if sv is None else f"{sv:.0f} -> {rv:.0f}"
                print(f"| {v} | {src} | {reason} | {s['n']} | {s['win']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} | {s['wait']:.0f} | {pr} | {vr} | {yrs} | {', '.join(s['top'])}; worst {', '.join(s['bottom'])} |", flush=True)
                if reason != "all": continue
                for r, u in zip(h, usd):
                    p = r["pick"][v]
                    rows_out.append(dict(part=part, version=v, list=src, date=r["date"], skip_minute=p["m0"], minute=r["minute"], sym=r["sym"],
                                         right=r["right"], reason=p["reason"], contract=p["contract"], delta=p["delta"], price=p["price"],
                                         vol30=p["vol30"], skip_price=p["skip_price"], skip_vol=p["skip_vol"], usd10k=round(u)))


def main():
    mains = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", "main", t) for t in FR.signals("25")]
    addj = [("fair", "add", t) for t in fe.fair_signals("s_t18r15")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(mains), "main signals,", len(addj), "add signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: P = pool.map(first, mains, chunksize=4)
    reasons = collections.Counter((p["src"], p.get("reason", "champ")) for p in P)
    print("pass 1:", dict(reasons), flush=True)
    L = legs(P)
    by_leg = collections.defaultdict(list)   # one walk per distinct leg
    for k, ms in L.items():
        for mode, (p, g) in ms.items():
            by_leg[(p["src"], p["sym"], p["date"], g[0], g[1], g[3][0])].append((mode, p, g))
    print(f"retry legs: {len(by_leg)}; by mode:", dict(collections.Counter(m for v in by_leg.values() for m, _, _ in v)), flush=True)
    if LISTING:
        miss = sorted({(k[2], k[5], k[3]) for k, v in by_leg.items() if not RB.quote(k[5], k[2], k[3])})
        with open(os.path.join(HERE, "open35_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(miss)
        print(f"{len(miss)} legs with no book at entry, on {len({m[0] for m in miss})} days -> open35_dbx_list.csv"); return
    rj = [((v[0][1], v[0][2]), tuple(m for m, _, _ in v)) for v in by_leg.values()]
    with mp.Pool(8) as pool:
        C = pool.map(walk_champ, [p for p in P if "champ" in p], chunksize=4)
        Rt = pool.map(walk_retry, rj, chunksize=2)
        A = pool.map(TS.one, addj, chunksize=4)
    R = [r for r in C + Rt if r] + [r for r in A if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out, rows = {}, []
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    pk = max(MODES[1:], key=score)
    out["pick"] = pk
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs champ, 2%): {pk} ({score(pk):.3f}); better on both: {score(pk) > 1}")
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the pick only", ("champ", pk))
    added(R, "tune", out, MODES[1:], rows)
    added(R, "check", out, (pk,), rows)
    bk = [r["pick"][next(iter(r["pick"]))]["book"] for r in R if r["kind"] == "main" and "champ" not in r["v"]]
    print(f"\nretried legs walked: {len(bk)}; a real book at entry: {sum(bk) / max(1, len(bk)):.0%}")
    json.dump(out, open(f"{B}/retry_skip_summary.json", "w"), indent=1)
    with open(f"{B}/retry_skip_added.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
