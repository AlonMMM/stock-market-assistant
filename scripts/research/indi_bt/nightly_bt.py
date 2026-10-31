"""nightly-bet v2: the option test of the score built from nightly_bins.py (the user 2026-10-31 "yes" to: rank each night's
candidates by activity + strength against SPY + pullback, ~300 bets a year, real option quotes, tune and check together).

Universe: the ~310 stocks of nightly_feat.py. Rows: its stock-side-nights, no earnings night or morning, not Friday.
Gate (can be scored): rs_day >= 0.5 and pos >= 0.6 (the analysis pool). Parts, each the mean of its measures'
percentiles in the tune weeks' pool (so the check weeks do not set the scale):
  ACT   rvol, rvol_late, burst_n             (the direction lead grew most with these: +2.6 / +2.9 / +2.7 pts)
  RS    rs_day, t                            (+2.0 / +1.9 pts, in the top band)
  PULL  depth, minus lh_run                  (+1.6 pts; a last-hour pullback +0.14% our way vs a run-up -0.01%)
Score = weights . parts. Each night: the gate-passing sides with score >= the tune pool's 80th percentile, best first;
the first 2 that get an option (the next-day one if liquid, else the nearest liquid one 1-4 days out: indi_close.py
"fb"; delta 0.20, $0.20 and 200 contracts in the last 30 minutes) are bought at 15:57 and sold next morning by his exit
(indi_close.py walk, real Databento quotes, sold at the bid). Only the night's 6 best are tried. Set before running:
  ref        today's pick's rule on the same stocks: t >= 1.8, pos >= 0.9, day volume >= 1.3x, top 3 by t, next-day only
  a3r2p2     weights ACT 3, RS 2, PULL 2 (from the analysis)
  a3r2p0     the same without the pullback
  equal      1, 1, 1
  user       ACT 5 (his volume 2 + burst 3), RS 5, PULL 4 (the user's weights of IC_SET=score)
Picked on tune among the four scores by the end balance at 2%; the pick and the reference on check, in the same run.
(t here is nightly_feat.py's, close to the bot's but not the same code.) "Busy" is known at 15:57: every part reads only
the day to 15:57 and earlier sessions. One look-ahead in scale only: the percentiles come from all tune weeks 2024-2026,
so a 2024 night is ranked on a scale that includes later nights; live, a trailing year would set it.
Quotes: IC_PASS=list -> open25_dbx_list.csv, dbx_fetch.py open25.
NB_SET=delta (the user 2026-10-31 "go and test it": the big-winner rate by the option's delta): a3r2p0 at delta 0.10 /
0.15 / 0.20 / 0.30 -> nightly_bt_delta_trades.json, read by bigrate.py; quotes open28.

  node --env-file=.env <dir>/run.mjs nightly_bt.py      (from the app repo root)
"""
import bisect, collections, csv, datetime as dt, gzip, json, math, multiprocessing as mp, os, statistics as stt, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import indi_close as ic
import retry_roll as rr
from store import day
from split import half

ic.EXTRAS += [os.path.join(HERE, "dbx_cache", "open25"), os.path.join(HERE, "dbx_cache", "open28")]
DSET = os.environ.get("NB_SET") == "delta"
LISTING = ic.LISTING
F = "data/local/x/bt/nightly_feat.csv.gz"
B = "data/local/x/bt"
PARTS = {"ACT": ("rvol", "rvol_late", "burst_n"), "RS": ("rs_day", "t"), "PULL": ("depth", "-lh_run")}
VERSIONS = {"a3r2p2": (3, 2, 2), "a3r2p0": (3, 2, 0), "equal": (1, 1, 1), "user": (5, 5, 4)}
DELTAS = {v: 0.20 for v in VERSIONS}
if DSET:
    VERSIONS = {f"a3r2p0-d{round(d * 100):02d}": (3, 2, 0) for d in (0.10, 0.15, 0.20, 0.30)}
    DELTAS = {v: int(v[-2:]) / 100 for v in VERSIONS}
DELTAS["ref"] = 0.20
Q, N_NIGHT, TRY = 0.80, 2, 6


def f(x):
    try: return float(x)
    except (TypeError, ValueError): return None


def val(r, k): return -f(r[k[1:]]) if k.startswith("-") else f(r[k])


def load():
    rows = []
    with gzip.open(F, "rt") as fh:
        for r in csv.DictReader(fh):
            if r["earn"] == "1" or dt.date.fromisoformat(r["date"]).weekday() == 4: continue
            if r["date"] > ic.RB.LAST or rr.CAL.index(r["date"]) + 1 >= len(rr.CAL): continue
            rows.append(r)
    return rows


def px(job):
    sym, date = job
    b = {x[0]: x for x in day(sym, date)}
    return job, (b[387][4] if 387 in b else None)


def walk(job):
    key, r, right, win, d = job
    w = ic.walk(("fair", r, right, d, win, "his"))
    return key, w


def main():
    rows = load()
    pool = [r for r in rows if f(r["rs_day"]) >= 0.5 and f(r["pos"]) >= 0.6]
    print(len(rows), "side-nights;", len(pool), "in the pool", flush=True)
    tune = [r for r in pool if r["half"] == "tune"]
    S = {k: sorted(val(r, k) for r in tune if val(r, k) is not None) for ks in PARTS.values() for k in ks}
    pc = lambda k, x: bisect.bisect_right(S[k], x) / len(S[k]) if x is not None else 0.5
    part = {id(r): [stt.fmean(pc(k, val(r, k)) for k in ks) for ks in PARTS.values()] for r in pool}
    picks = {}
    for v, w in VERSIONS.items():
        sc = {id(r): sum(a * b for a, b in zip(w, part[id(r)])) for r in pool}
        thr = sorted(sc[id(r)] for r in tune)[int(Q * (len(tune) - 1))]
        by = collections.defaultdict(list)
        for r in pool:
            if sc[id(r)] >= thr: by[r["date"]].append((sc[id(r)], r))
        picks[v] = {d: [r for _, r in sorted(x, key=lambda q: -q[0])[:TRY]] for d, x in by.items()}
    # the reference: today's pick's rule
    by = collections.defaultdict(list)
    for r in rows:
        if f(r["t"]) >= 1.8 and f(r["pos"]) >= 0.9 and f(r["rvol"]) >= math.log(1.3): by[r["date"]].append((f(r["t"]), r))
    picks["ref"] = {d: [r for _, r in sorted(x, key=lambda q: -q[0])[:3]] for d, x in by.items()}
    WIN = {v: "fb" for v in VERSIONS}; WIN["ref"] = "next"
    need = {(r["sym"], r["date"]) for P in picks.values() for lst in P.values() for r in lst}
    with mp.Pool(8) as pool_: PX = dict(pool_.map(px, sorted(need), chunksize=20))
    jobs = {}
    for v, P in picks.items():
        for d, lst in P.items():
            for r in lst:
                if not PX.get((r["sym"], d)): continue
                key = (r["sym"], d, r["side"], WIN[v], DELTAS[v])
                jobs[key] = (key, {"sym": r["sym"], "date": d, "px": PX[(r["sym"], d)]}, r["side"], WIN[v], DELTAS[v])
    print(len(jobs), "trades to walk", flush=True)
    with mp.Pool(8) as pool_: W = dict(pool_.map(walk, list(jobs.values()), chunksize=4))

    def taken(v, d):
        out = []
        for r in picks[v].get(d, []):
            w = W.get((r["sym"], d, r["side"], WIN[v], DELTAS[v]))
            if w: out.append((r, w))
            if v != "ref" and len(out) >= N_NIGHT: break
        return out
    if LISTING:
        rowsq = sorted({x for v in picks for d in picks[v] for _, w in taken(v, d) for x in w})
        with open(os.path.join(HERE, "open28_dbx_list.csv" if DSET else "open25_dbx_list.csv"), "w") as fh:
            wr = csv.writer(fh); wr.writerow(["date", "contract", "minute"]); wr.writerows(rowsq)
        print(f"{len(rowsq)} rows on {len({x[0] for x in rowsq})} days -> open25_dbx_list.csv"); return

    def trades(v, part): return [(r, w) for d in sorted(picks[v]) if half(d) == part for r, w in taken(v, d)]
    def E(v, part, s): return [(w["date"], 389, 1.0, w["r"][s], 1) for _, w in trades(v, part)]
    def desc(T):
        u = [1e4 * max(-1, w["r"][0.02]) for _, w in T]; g = [x for x in u if x >= 3e4]
        if not u: return "0"
        yrs = collections.Counter(w["date"][:4] for _, w in T)
        return (f"{len(u)} ({', '.join(f'{y}: {n}' for y, n in sorted(yrs.items()))}), {sum(x > 0 for x in u)} win, median {stt.median(u):+,.0f}, "
                f"sum {sum(u):+,.0f}, {len(g)} giants, the rest {sum(u) - sum(g):+,.0f}, without best 5 {sum(sorted(u)[:-5]):+,.0f}")
    nights = {p: len({d for d in rr.CAL if ic.A0 <= d <= ic.RB.LAST and half(d) == p and dt.date.fromisoformat(d).weekday() != 4}) for p in ("tune", "check")}
    print(f"\nnights (no Fridays): tune {nights['tune']}, check {nights['check']}\n\n#### Tune weeks, 2% a trade from $100,000 (10% night cap)\n\n| Version | End / worst drop | Trades a year | Trades, winners, median, sum, giants, the rest, without best 5 ($10K a trade) |\n|---|---|---|---|")
    res = {}
    for v in ["ref"] + list(VERSIONS):
        s_ = rr.stats(E(v, "tune", 0.02), 0.02); res[v] = s_["acct"]
        T = trades(v, "tune")
        print(f"| {v} | ${s_['acct']:,} / {s_['dd']:.0%} | {len(T) / nights['tune'] * 200:.0f} | {desc(T)} |", flush=True)
    best = max(VERSIONS, key=lambda v: res[v])
    print(f"\nPicked on tune: {best} 🎯\n\n#### Check weeks\n\n| Version | 2% end / worst drop | 3% end / worst drop | Trades a year | Detail |\n|---|---|---|---|---|")
    for v in ("ref", best):
        a, b = rr.stats(E(v, "check", 0.02), 0.02), rr.stats(E(v, "check", 0.03), 0.03)
        T = trades(v, "check")
        print(f"| {v} | ${a['acct']:,} / {a['dd']:.0%} | ${b['acct']:,} / {b['dd']:.0%} | {len(T) / nights['check'] * 200:.0f} | {desc(T)} |", flush=True)
    bk = [w["book"] for w in W.values() if w]
    print(f"\nfills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    json.dump({f"{v}|{p}": [dict(date=w["date"], sym=w["sym"], right=w["right"], contract=w["contract"], r={str(k): x for k, x in w["r"].items()})
                            for _, w in trades(v, p)] for v in ["ref"] + list(VERSIONS) for p in ("tune", "check")},
              open(f"{B}/nightly_bt{'_delta' if DSET else ''}_trades.json", "w"))


if __name__ == "__main__":
    main()
