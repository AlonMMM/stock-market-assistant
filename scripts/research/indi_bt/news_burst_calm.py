"""nightly-bet: news + a sudden volume burst, but the price stayed calm (the user 2026-11-02: "take a bet if: there was news
on that stock during the day, volume uncreases sudenly but the price did not go huge on any direction. (hugw is like 5S30
or bigger) by the end of the day"; then, asked: the side = "The day's small move side", huge = "Both").

Universe: the top 50 of strangle_rank.json, nights Mon-Thu from Feb 2024, no earnings night or morning (nightly_feat earn).
At 15:57 (minute 387), per stock-day:
  burst   a minute with volume >= 5x that minute's usual and >= usual + 8 robust deviations (the 20 sessions before,
          earnings reaction days out; nightly_feat.py), minutes within 2 of each other one event; only events starting
          09:31-15:44 (the closing-imbalance spikes left out). The day's burst = the event with the most extra volume.
  calm    |the move from yesterday's close to 15:57| < L x S30 AND |the move from the minute before the burst to 15:57|
          < L x S30 (S30 = the stock's usual 30-minute move, the spread of its 1-minute returns over the 20 sessions
          before x sqrt 30). Raw stock moves, not vs SPY.
  news    Alpaca / Benzinga headlines on the stock (tagged with at most 3 symbols, so market wraps don't count) from
          04:00 to 15:57 that day; "near" = within 60 minutes before to 15 minutes after the burst's start.
  side    the call when the stock is above beta x SPY + sector at 15:57 (nightly_feat rs_day > 0), else the put.
At most 2 bets a night, the biggest bursts first (next in order when no liquid option). Versions, set before running:
  calm5        burst + calm at 5, no news needed (what the news adds)
  news5        the thesis: news + burst + calm at 5
  near5        news near the burst + calm at 5
  news3 / news7  the thesis at 3 / 7 S30
Bought 15:57, delta 0.20, fb expiry (indi_close: next-day or nearest liquid 1-4 days, $0.20 / 200 contracts), his exit,
real quotes at the bid, 10% night cap, 2% a bet. Tune = even ISO weeks, check = odd (split.half); picked on tune by the
$100K end at 2%; the pick on check, same run. Quotes: IC_PASS=list -> open34_dbx_list.csv, dbx_fetch.py open34.

  node --env-file=.env <dir>/run.mjs news_burst_calm.py      (from the app repo root)
"""
import collections, csv, datetime as dt, gzip, json, math, multiprocessing as mp, os, sys
from zoneinfo import ZoneInfo
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import indi_close as ic
import retry_roll as rr
import store
import nightly_feat as nf
from split import half
from sig_lasthour import row

ic.EXTRAS += [os.path.join(HERE, "dbx_cache", "open34")]
B = "data/local/x/bt"
NEWS = f"{B}/news_day"; os.makedirs(NEWS, exist_ok=True)
TOP = json.load(open(os.path.join(HERE, "strangle_rank.json")))[:50]
M = 387
NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
VERSIONS = {"calm5": (5, None), "news5": (5, "day"), "near5": (5, "near"), "news3": (3, "day"), "news7": (7, "day")}


def bursts(sym):
    """{date: (day_move_S30, [(start, extra_volume_share, move_since_S30), ...])} for every day from A0."""
    CAL, IDX = nf.CAL, nf.IDX
    ER = nf.EARN.get(sym, set())
    out = {}
    i0 = IDX.get(nf.A0, 0)
    A = {k: nf.arrays(sym, CAL[k]) for k in range(max(0, i0 - 25), len(CAL))}
    A = {k: x for k, x in A.items() if x}
    for i in range(i0, len(CAL)):
        a, pa = A.get(i), A.get(i - 1)
        if not a or not pa: continue
        p20 = [k for k in range(i - 20, i) if k in A][-20:]
        if len(p20) < 12: continue
        o, h, l, c, v = a
        r1 = np.concatenate([np.diff(A[k][3]) / A[k][3][:-1] for k in p20])
        S30 = float(np.std(r1)) * math.sqrt(30) or 1e-4
        keep = [k for k in p20 if k not in ER]
        pv = np.array([A[k][4] for k in (keep if len(keep) >= 10 else p20)])
        med = np.median(pv, axis=0); mad = np.median(np.abs(pv - med), axis=0) * 1.4826
        usual = float(med.sum()) or 1.0
        thr = np.maximum(5 * med, med + 8 * np.maximum(mad, 1))
        ev = []
        for m in range(1, M + 1):
            if v[m] >= thr[m] and v[m] > 0:
                if ev and m - ev[-1][1] <= 2: ev[-1][1] = m
                else: ev.append([m, m])
        B_ = [(s_, float((v[s_:z + 1] - med[s_:z + 1]).clip(0).sum() / usual), abs(c[M] / c[s_ - 1] - 1) / S30)
              for s_, z in ev if 1 <= s_ <= 374]
        out[CAL[i]] = (abs(c[M] / pa[3][389] - 1) / S30, B_)
    return sym, out


def news_day(sym, d):
    p = f"{NEWS}/{sym}_{d}.json"
    if os.path.exists(p): return json.load(open(p))
    s = dt.datetime.fromisoformat(f"{d}T04:00").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = dt.datetime.fromisoformat(f"{d}T15:57").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"https://data.alpaca.markets/v1beta1/news?symbols={sym}&start={s}&end={e}&limit=50&sort=asc&include_content=false"
    out, tok = [], None
    while True:
        r = store._get(url + (f"&page_token={tok}" if tok else ""))
        for n in r.get("news") or []:
            if len(n.get("symbols") or []) > 3: continue
            t = dt.datetime.fromisoformat(n["created_at"].replace("Z", "+00:00")).astimezone(NY)
            out.append([t.hour * 60 + t.minute - 570, n.get("headline", "")[:160]])
        tok = r.get("next_page_token")
        if not tok: break
    json.dump(out, open(p, "w")); return out


def walk(job):
    key, r, right = job
    return key, ic.walk(("fair", r, right, 0.20, "fb", "his"))


def px1557(job):
    s, d = job
    b = {x[0]: x for x in store.day(s, d)}
    return job, (b[M][4] if M in b else None)


def main():
    feat = {}
    with gzip.open(f"{B}/nightly_feat.csv.gz", "rt") as fh:
        for x in csv.DictReader(fh):
            if x["side"] != "C" or x["sym"] not in TOP or x["earn"] == "1" or x["date"] < ic.A0 or x["date"] > ic.RB.LAST: continue
            if dt.date.fromisoformat(x["date"]).weekday() == 4 or rr.CAL.index(x["date"]) + 1 >= len(rr.CAL): continue
            if x["rs_day"] in ("", None) or float(x["rs_day"]) == 0: continue
            feat[(x["sym"], x["date"])] = "C" if float(x["rs_day"]) > 0 else "P"
    with mp.Pool(8) as p: BU = dict(p.map(bursts, TOP))
    cand = []   # (date, sym, side, burst start, size, day move, move since)
    for (s, d), side in feat.items():
        got = BU.get(s, {}).get(d)
        if not got or not got[1]: continue
        st_, sz, since = max(got[1], key=lambda b: b[1])
        if got[0] < 7 and since < 7: cand.append((d, s, side, st_, sz, got[0], since))
    print(f"stock-nights {len(feat)}, with a burst {sum(1 for k in feat if BU.get(k[0], {}).get(k[1], (0, []))[1])}, "
          f"calm at 7 {len(cand)}", flush=True)
    NW = {}
    for j, (d, s, *_r) in enumerate(sorted(cand)):
        NW[(s, d)] = news_day(s, d)
        if j % 500 == 0: print(f"news {j}/{len(cand)}", flush=True)
    order = {v: collections.defaultdict(list) for v in VERSIONS}
    for d, s, side, st_, sz, mv, since in cand:
        n = NW[(s, d)]
        for v, (L, nk) in VERSIONS.items():
            if mv >= L or since >= L: continue
            if nk == "day" and not n: continue
            if nk == "near" and not any(st_ - 60 <= t <= st_ + 15 for t, _ in n): continue
            order[v][d].append(dict(sym=s, side=side, size=sz))
    for v in order:
        for d in order[v]: order[v][d].sort(key=lambda r: -r["size"])
    need = {(r["sym"], d, r["side"]) for v in order for d, R in order[v].items() for r in R[:6]}
    with mp.Pool(8) as p: PX = dict(p.map(px1557, sorted({(s, d) for s, d, _ in need}), chunksize=20))
    jobs = [((s, d, rt), {"sym": s, "date": d, "px": PX[(s, d)]}, rt) for s, d, rt in sorted(need) if PX.get((s, d))]
    with mp.Pool(8) as p: W = {k: w for k, w in p.map(walk, jobs, chunksize=4) if w}
    if ic.LISTING:
        rowsq = sorted({x for w in W.values() for x in w})
        with open(os.path.join(HERE, "open34_dbx_list.csv"), "w") as fh:
            wr = csv.writer(fh); wr.writerow(["date", "contract", "minute"]); wr.writerows(rowsq)
        print(f"{len(rowsq)} rows on {len({x[0] for x in rowsq})} days -> open34_dbx_list.csv"); return
    bets = {v: [] for v in VERSIONS}
    for v in VERSIONS:
        for d in sorted(order[v]):
            bets[v] += [W[(r["sym"], d, r["side"])] for r in order[v][d][:6] if (r["sym"], d, r["side"]) in W][:2]
    print("candidates a version (stock-nights / nights): " + ", ".join(
        f"{v} {sum(len(R) for R in order[v].values())} / {len(order[v])}" for v in VERSIONS))
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
                   for w in L] for v, L in bets.items()}, open(f"{B}/news_burst_calm_trades.json", "w"))


if __name__ == "__main__":
    main()
