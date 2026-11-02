"""nightly-bet: the bot picks the night's stock the way Indi does, bought between 15:00 and the close.
The user 2026-11-02: "lets test it only on 2024-2025 than we can test on 2026. volume is not needed. extreme volume can
as some score but no treshold. stock must be in it's top - it should score as well. you can choose time from 15:00 to
the end of day. be aware of the volume increase of the end of the day and the spikes at last 15 minutes (balancers)".

Universe: the top 50 of strangle_rank.json, both sides, nights Mon-Thu, no earnings night or morning (nightly_feat earn),
Feb 2024 on. Tune = 2024-2025, check = 2026 (the user's split for this test), both in the same run.
At the entry minute E (15:00 / 15:30 / 15:45 / 15:57), each stock-side, signed its way:
  rs     move from the day before's close to E minus beta x SPY's, in the daily residual sd (beta, sd: prior 60 days)
  t      the minute excess moves (stock - beta x SPY) 09:31 -> E: mean / sd x sqrt(n)
  pos    place in the day's range to E (puts: from the top); GATE pos >= 0.85 ("must be in its top") and scored
  vwap   distance from the day's VWAP to E, in the daily ATR
  rs5    the 5 days before vs beta x SPY, z;  sma50  distance above the 50-day average, in ATR
  volume no gate: +0.1 to the score when the stock's volume is in the night's top 10%; volume = 09:30 -> min(E, 15:44)
         / the median of the same minutes over the prior 20 sessions (the closing rush and the 15:45+ imbalance
         prints never count, and the time of day is compared with itself)
Score = mean percentile of rs, t, pos, vwap, rs5, sma50 among the night's same-side rows (gated or not) + volume bonus.
Version per E: the night's best gated score; if it has no liquid option, the next (indi_close "fb": next-day or nearest
liquid 1-4 days, delta 0.20, $0.20 / 200 contracts in the 30 minutes before E). Bought at E, his exit, real quotes at
the bid, 10% night cap, 2% a bet. Reference: his own overnight stock, side and date (indi_nights.json, from the night
book), bought at 15:57 the same way. Picked on tune by the $100K end at 2%; all shown on 2026.
Quotes: IC_PASS=list -> open33_dbx_list.csv, dbx_fetch.py open33.

  node --env-file=.env <dir>/run.mjs indi_choice_late.py      (from the app repo root)
"""
import collections, csv, datetime as dt, gzip, json, math, multiprocessing as mp, os, sqlite3, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import indi_close as ic
import retry_roll as rr
from store import day
from sig_lasthour import row

ic.EXTRAS += [os.path.join(HERE, "dbx_cache", "open33")]
B = "data/local/x/bt"
TOP = json.load(open(os.path.join(HERE, "strangle_rank.json")))[:50]
ES = {"e1500": 330, "e1530": 360, "e1545": 375, "e1557": 387}
VCAP = 374
DEPTH = 6
part = lambda d: "tune" if d < "2026" else "check"


def daily(sym):
    db = sqlite3.connect(f"{B}/daily_all.sqlite")
    return db.execute("select date,o,h,l,c,v from day where symbol=? order by date", (sym,)).fetchall()


def per_symbol(sym):
    """call-side features at each E for every day of the symbol; None when data is missing."""
    D = daily(sym); S = {r[0]: r[4] for r in daily("SPY")}
    out = {}; vhist = collections.defaultdict(list)
    idx = {r[0]: i for i, r in enumerate(D)}
    for d in rr.CAL:
        if d < "2023-12-01" or d > ic.RB.LAST or d not in idx: continue
        i = idx[d]
        bars = day(sym, d)
        bm = {b[0]: b for b in bars} if bars else {}
        cv = {E: sum(b[5] for b in bars if b[0] <= min(E, VCAP)) for E in ES.values()} if bars else {}
        if d >= ic.A0 and i >= 130 and bars and all(len(vhist[E]) >= 15 for E in ES.values()):
            P = D[i - 61:i]
            if all(x[0] in S for x in P):
                C = [x[4] for x in P]; Sp = [S[x[0]] for x in P]
                rs = [C[j] / C[j - 1] - 1 for j in range(1, 61)]; rm = [Sp[j] / Sp[j - 1] - 1 for j in range(1, 61)]
                mr, mm = st.mean(rs), st.mean(rm)
                b_ = sum((a - mr) * (c - mm) for a, c in zip(rs, rm)) / (sum((c - mm) ** 2 for c in rm) or 1e-12)
                sd = st.pstdev([a - b_ * c for a, c in zip(rs, rm)]) or 1e-9
                atr = st.mean(max(P[j][2], P[j - 1][4]) - min(P[j][3], P[j - 1][4]) for j in range(47, 61)) or 1e-9
                rs5 = ((C[-1] / C[-6] - 1) - b_ * (Sp[-1] / Sp[-6] - 1)) / (sd * math.sqrt(5))
                sma = (C[-1] - st.mean(C[-50:])) / atr
                spy = {b[0]: b[4] for b in (day("SPY", d) or [])}
                pc, spc = C[-1], Sp[-1]
                F = {}
                for name, E in ES.items():
                    if E not in bm or E not in spy: continue
                    upto = [b for b in bars if b[0] <= E]
                    ex = []
                    for a, b in zip(upto, upto[1:]):
                        if a[0] in spy and b[0] in spy and a[4] > 0:
                            ex.append((b[4] / a[4] - 1) - b_ * (spy[b[0]] / spy[a[0]] - 1))
                    if len(ex) < 100: continue
                    sdx = st.pstdev(ex) or 1e-9
                    hi = max(b[2] for b in upto); lo = min(b[3] for b in upto); px = bm[E][4]
                    vol = sum(b[5] for b in upto); pv = sum(b[5] * (b[2] + b[3] + b[4]) / 3 for b in upto)
                    F[name] = dict(px=px, rs=((px / pc - 1) - b_ * (spy[E] / spc - 1)) / sd, t=st.mean(ex) / sdx * math.sqrt(len(ex)),
                                   pos=(px - lo) / (hi - lo) if hi > lo else 0.5, vwap=(px - pv / vol) / atr if vol else 0.0,
                                   rs5=rs5, sma50=sma, rvol=cv[E] / (st.median(vhist[E][-20:]) or 1))
                if F: out[d] = F
        for E in ES.values():
            if cv.get(E): vhist[E].append(cv[E])
    return sym, out


def pct(vals, v): return sum(1 for x in vals if x < v) / len(vals)


def walk(job):
    key, r, right, E = job
    ic.M_IN = E
    return key, ic.walk(("fair", r, right, 0.20, "fb", "his"))


def px_at(job):
    s, d, E = job
    b = {x[0]: x for x in (day(s, d) or [])}
    return job, (b[E][4] if E in b else None)


def main():
    earn = set()
    with gzip.open(f"{B}/nightly_feat.csv.gz", "rt") as fh:
        for x in csv.DictReader(fh):
            if x["earn"] == "1" and x["sym"] in TOP: earn.add((x["sym"], x["date"]))
    with mp.Pool(8) as p: FEAT = dict(p.map(per_symbol, TOP, chunksize=1))
    K = ["rs", "t", "pos", "vwap", "rs5", "sma50"]
    order = {v: {} for v in ES}
    for v in ES:
        for d in rr.CAL:
            if d < ic.A0 or d > ic.RB.LAST or dt.date.fromisoformat(d).weekday() == 4 or rr.CAL.index(d) + 1 >= len(rr.CAL): continue
            R = []
            for s in TOP:
                f = FEAT.get(s, {}).get(d, {}).get(v)
                if not f or (s, d) in earn: continue
                for side, g in (("C", 1), ("P", -1)):
                    R.append(dict(sym=s, side=side, px=f["px"], rvol=f["rvol"], rs=g * f["rs"], t=g * f["t"],
                                  pos=f["pos"] if g > 0 else 1 - f["pos"], vwap=g * f["vwap"], rs5=g * f["rs5"], sma50=g * f["sma50"]))
            if len(R) < 60: continue
            rv = [r["rvol"] for r in R]
            for side in "CP":
                Sd = [r for r in R if r["side"] == side]
                for r in Sd:
                    r["score"] = st.mean(pct([z[k] for z in Sd], r[k]) for k in K) + (0.1 if pct(rv, r["rvol"]) >= 0.9 else 0)
            G = sorted((r for r in R if r["pos"] >= 0.85), key=lambda r: -r["score"])
            if G: order[v][d] = G[:DEPTH]
    his = [h for h in json.load(open(f"{B}/indi_nights.json")) if h["date"] <= ic.RB.LAST and rr.CAL.index(h["date"]) + 1 < len(rr.CAL)]
    need = {(r["sym"], d, r["side"], ES[v]) for v in ES for d, G in order[v].items() for r in G}
    need |= {(h["sym"], h["date"], h["right"], 387) for h in his}
    with mp.Pool(8) as p: PX = dict(p.map(px_at, sorted({(s, d, E) for s, d, _, E in need}), chunksize=20))
    jobs = [((s, d, rt, E), {"sym": s, "date": d, "px": PX[(s, d, E)]}, rt, E) for s, d, rt, E in sorted(need) if PX.get((s, d, E))]
    with mp.Pool(8) as p: W = {k: w for k, w in p.map(walk, jobs, chunksize=4) if w}
    if ic.LISTING:
        rowsq = sorted({x for w in W.values() for x in w})
        with open(os.path.join(HERE, "open33_dbx_list.csv"), "w") as fh:
            wr = csv.writer(fh); wr.writerow(["date", "contract", "minute"]); wr.writerows(rowsq)
        print(f"{len(rowsq)} rows on {len({x[0] for x in rowsq})} days -> open33_dbx_list.csv"); return
    bets = {}
    for v in ES:
        bets[v] = []
        for d, G in sorted(order[v].items()):
            got = next((W[(r["sym"], d, r["side"], ES[v])] for r in G if (r["sym"], d, r["side"], ES[v]) in W), None)
            if got: bets[v].append(got)
    bets["his names 15:57"] = [W[(h["sym"], h["date"], h["right"], 387)] for h in his if (h["sym"], h["date"], h["right"], 387) in W]
    hisset = {(h["date"], h["sym"], h["right"]) for h in his}
    head = ("| Version | Years | Bets | Big (+300%) | Their avg | Others' avg | Per bet | Median | Per bet without best 5 | "
            "$100K at 2% / worst drop | at 3% | Per bet by year (bets) |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
    T = lambda v, pt: sorted((w for w in bets[v] if part(w["date"]) == pt), key=lambda w: w["date"])
    end = {}
    print(f"nights with a gated pick: " + ", ".join(f"{v} {len(order[v])}" for v in ES) + f"; his overnight trades from Feb 2024: {len(his)}, got an option at 15:57: {len(bets['his names 15:57'])}")
    print("\n#### 2024-2025 (tune)\n\n" + head)
    for v in bets:
        out = row(T(v, "tune"))
        if out:
            print(f"| {v} | 2024-25 | {out[0]} |", flush=True)
            if v in ES: end[v] = rr.stats([(w["date"], 389, 1.0, w["r"][0.02], 1) for w in T(v, "tune")], 0.02)["acct"]
    pick = max(end, key=end.get)
    print(f"\nPicked on 2024-25: {pick} 🎯\n\n#### 2026 (check)\n\n" + head)
    for v in bets:
        out = row(T(v, "check"))
        if out: print(f"| {v}{' 🎯' if v == pick else ''} | 2026 | {out[0]} |")
    for v in ES:
        c = collections.Counter(w["sym"] for w in bets[v])
        same = sum((w["date"], w["sym"], w["right"]) in hisset for w in bets[v])
        print(f"{v}: {len(bets[v])} bets, {same} the same as his; most bought {', '.join(f'{s} {n}' for s, n in c.most_common(8))}; "
              f"calls {sum(w['right'] == 'C' for w in bets[v])} / puts {sum(w['right'] == 'P' for w in bets[v])}")
    bk = [w["book"] for w in W.values()]
    print(f"\nfills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    json.dump({v: [dict(date=w["date"], sym=w["sym"], right=w["right"], contract=w["contract"], r={str(a): x for a, x in w["r"].items()})
                   for w in L] for v, L in bets.items()}, open(f"{B}/indi_choice_late_trades.json", "w"))


if __name__ == "__main__":
    main()
