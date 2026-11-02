"""nightly-bet: copy Indi's choice of the night (the user 2026-11-02: "go", on the plan after indi_pick_vs_list.py found his
overnight stock is the day's strongest name vs SPY on the top-50 list, median #4 of ~47, the most traded of the leaders).

Universe: the top 50 of strangle_rank.json (today's list), both sides, nights Mon-Thu from Feb 2024, no earnings night or
morning (nightly_feat.py earn). Score at 15:57 = the mean percentile, among that night's same-side rows, of rs_day, t,
vwap_ext, pos, rvol, burst (nightly_feat.py) + 5-day residual vs beta*SPY and the distance above the 50-day average in
ATR (daily_all.sqlite) ("day6+trend" of indi_pick_vs_list.py). Both sides ranked together. Versions, set before running:
  top1    the night's best score
  top1$   of the night's 5 best scores, the most dollar volume (nightly_feat dollar)
  top2    the two best scores
If a name has no liquid option (indi_close "fb": next-day or nearest liquid 1-4 days, delta 0.20, $0.20 / 200 contracts),
the next in that order is taken. Bought 15:57, his exit (indi_close walk "his"), real quotes at the bid, 10% night cap,
2% a bet. Picked on tune by the $100K end at 2%; the pick on check, same run. Quotes: IC_PASS=list -> open32_dbx_list.csv,
dbx_fetch.py open32.

  node --env-file=.env <dir>/run.mjs nightly_copy.py      (from the app repo root)
"""
import collections, csv, datetime as dt, gzip, json, math, multiprocessing as mp, os, sqlite3, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import indi_close as ic
import retry_roll as rr
from store import day
from split import half
from sig_lasthour import row

ic.EXTRAS += [os.path.join(HERE, "dbx_cache", "open32")]
B = "data/local/x/bt"
TOP = json.load(open(os.path.join(HERE, "strangle_rank.json")))[:50]
F = ["rs_day", "t", "vwap_ext", "pos", "rvol", "burst"]
DEPTH = 6


def daily_feats():
    db = sqlite3.connect(f"{B}/daily_all.sqlite")
    get = lambda s: db.execute("select date,o,h,l,c,v from day where symbol=? order by date", (s,)).fetchall()
    spy = {r[0]: r[4] for r in get("SPY")}
    out = {}
    for s in TOP:
        D = get(s)
        for i in range(130, len(D)):
            d = D[i][0]
            if d < ic.A0: continue
            P = D[i - 61:i]
            if any(x[0] not in spy for x in P): continue
            C = [x[4] for x in P]; S = [spy[x[0]] for x in P]
            rs = [C[j] / C[j - 1] - 1 for j in range(1, 61)]; rm = [S[j] / S[j - 1] - 1 for j in range(1, 61)]
            mr, mm = st.mean(rs), st.mean(rm)
            b = sum((a - mr) * (c - mm) for a, c in zip(rs, rm)) / (sum((c - mm) ** 2 for c in rm) or 1e-12)
            sd = st.pstdev([a - b * c for a, c in zip(rs, rm)]) or 1e-9
            tr = [max(P[j][2], P[j - 1][4]) - min(P[j][3], P[j - 1][4]) for j in range(47, 61)]
            atr = st.mean(tr) or 1e-9
            rs5 = ((C[-1] / C[-6] - 1) - b * (S[-1] / S[-6] - 1)) / (sd * math.sqrt(5))
            sma = (C[-1] - st.mean(C[-50:])) / atr
            out[(s, d)] = (rs5, sma)   # call side; the put side is the negative
    return out


def pct(vals, v): return sum(1 for x in vals if x < v) / len(vals)


def walk(job):
    key, r, right = job
    return key, ic.walk(("fair", r, right, 0.20, "fb", "his"))


def px1557(job):
    s, d = job
    b = {x[0]: x for x in day(s, d)}
    return job, (b[387][4] if 387 in b else None)


def main():
    DF = daily_feats()
    rows = collections.defaultdict(list)
    with gzip.open(f"{B}/nightly_feat.csv.gz", "rt") as fh:
        for x in csv.DictReader(fh):
            if x["sym"] not in TOP or x["earn"] == "1" or x["date"] < ic.A0 or x["date"] > ic.RB.LAST: continue
            if dt.date.fromisoformat(x["date"]).weekday() == 4 or rr.CAL.index(x["date"]) + 1 >= len(rr.CAL): continue
            if any(x[k] in ("", None) for k in F + ["dollar"]) or (x["sym"], x["date"]) not in DF: continue
            g = 1 if x["side"] == "C" else -1
            rs5, sma = DF[(x["sym"], x["date"])]
            rows[x["date"]].append(dict(sym=x["sym"], side=x["side"], dollar=float(x["dollar"]), rs5=g * rs5, sma50=g * sma,
                                        **{k: float(x[k]) for k in F}))
    K = F + ["rs5", "sma50"]
    order = {}
    for d, R in rows.items():
        for side in "CP":
            S = [r for r in R if r["side"] == side]
            if len(S) < 15: continue
            for r in S: r["score"] = st.mean(pct([z[k] for z in S], r[k]) for k in K)
        R = [r for r in R if "score" in r]
        if len(R) < 30: continue
        R.sort(key=lambda r: -r["score"])
        top5 = sorted(R[:5], key=lambda r: -r["dollar"])
        order[d] = {"top1": R[:DEPTH], "top2": R[:DEPTH + 1], "top1$": top5 + R[5:DEPTH + 1]}
    nights = sorted(order)
    print(f"nights {len(nights)} (tune {sum(half(d) == 'tune' for d in nights)}, check {sum(half(d) == 'check' for d in nights)})", flush=True)
    need = {(r["sym"], d, r["side"]) for d in nights for v in order[d].values() for r in v}
    with mp.Pool(8) as p: PX = dict(p.map(px1557, sorted({(s, d) for s, d, _ in need}), chunksize=20))
    jobs = [((s, d, rt), {"sym": s, "date": d, "px": PX[(s, d)]}, rt) for s, d, rt in sorted(need) if PX.get((s, d))]
    with mp.Pool(8) as p: W = {k: w for k, w in p.map(walk, jobs, chunksize=4) if w}
    if ic.LISTING:
        rowsq = sorted({x for w in W.values() for x in w})
        with open(os.path.join(HERE, "open32_dbx_list.csv"), "w") as fh:
            wr = csv.writer(fh); wr.writerow(["date", "contract", "minute"]); wr.writerows(rowsq)
        print(f"{len(rowsq)} rows on {len({x[0] for x in rowsq})} days -> open32_dbx_list.csv"); return
    bets = {v: [] for v in ("top1", "top1$", "top2")}
    for d in nights:
        for v, want in (("top1", 1), ("top1$", 1), ("top2", 2)):
            got = [W[(r["sym"], d, r["side"])] for r in order[d][v] if (r["sym"], d, r["side"]) in W][:want]
            bets[v] += got
    head = ("| Version | Half | Bets | Big (+300%) | Their avg | Others' avg | Per bet | Median | Per bet without best 5 | "
            "$100K at 2% / worst drop | at 3% | Per bet by year (bets) |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
    T = lambda v, part: sorted((w for w in bets[v] if half(w["date"]) == part), key=lambda w: w["date"])
    print("\n#### Tune weeks\n\n" + head)
    end = {}
    for v in bets:
        out = row(T(v, "tune"))
        if out:
            print(f"| {v} | tune | {out[0]} |", flush=True)
            end[v] = rr.stats([(w["date"], 389, 1.0, w["r"][0.02], 1) for w in T(v, "tune")], 0.02)["acct"]
    pick = max(end, key=end.get)
    print(f"\nPicked on tune: {pick} 🎯\n\n#### Check weeks\n\n" + head)
    out = row(T(pick, "check"))
    if out: print(f"| {pick} | check | {out[0]} |")
    for v in bets:
        c = collections.Counter(w["sym"] for w in bets[v])
        print(f"{v}: most bought {', '.join(f'{s} {n}' for s, n in c.most_common(8))}; calls {sum(w['right'] == 'C' for w in bets[v])} / puts {sum(w['right'] == 'P' for w in bets[v])}")
    bk = [w["book"] for w in W.values()]
    print(f"\nfills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    json.dump({v: [dict(date=w["date"], sym=w["sym"], right=w["right"], contract=w["contract"], r={str(a): x for a, x in w["r"].items()})
                   for w in L] for v, L in bets.items()}, open(f"{B}/nightly_copy_trades.json", "w"))


if __name__ == "__main__":
    main()
