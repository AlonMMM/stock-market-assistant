"""D3 checked (d3.py; the user, 2026-10-30): 1. per stock, how often D3 / D3-last is high at 15:57 (is it fair across
stocks, unlike D2); 2. Indi's late overnight buys (close_miss.csv) at his minute vs the other stocks of our lists;
3. all his entries (his_tvd.csv): winners / losers / giants, giants per 100 by D3-last.

  python3 d3_check.py      (from the app repo root)  -> data/local/x/bt/d3_his.csv
"""
import collections, csv, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import d3 as D3
import fav_real as FR
from low_delta import HIS40

B = "data/local/x/bt"
SYMS = sorted(set(HIS40) | FR.FAV)


def at(job):
    sym, date, m, side = job
    try: return job, D3.d3(sym, date, m, side)
    except Exception: return job, None


def his_min(r): return int(r["time"][:2]) * 60 + int(r["time"][3:5]) - 570


def main():
    q = lambda xs, p: sorted(xs)[int(p * (len(xs) - 1))] if xs else float("nan")
    # 1. fairness across stocks
    days = [d for d in D3.CAL if "2025-01-01" <= d <= "2026-10-20"][::3]
    with mp.Pool(8) as pool: A = pool.map(at, [(s, d, 387, side) for s in SYMS for d in days for side in ("C",)], chunksize=40)
    by = collections.defaultdict(list)
    for (s, d, m, side), x in A:
        if x: by[s].append(x)
    rows = [(s, len(X), sum(x["held"] >= 0.5 for x in X) / len(X), sum(x["d3"] >= 0.5 for x in X) / len(X), sum((x["d3_last"] or -9) >= 0.5 for x in X) / len(X)) for s, X in by.items() if len(X) > 60]
    print("#### 1. Share of days at 15:57 (calls), every 3rd day 2025-26: raw held >= 0.5 / D3 >= 0.5 / D3-last >= 0.5\n")
    for lab, k in (("raw held", 2), ("D3", 3), ("D3-last", 4)):
        v = [r[k] for r in rows]
        print(f"{lab}: median {st.median(v):.0%}, spread p10-p90 {q(v, .1):.0%}-{q(v, .9):.0%}; " + ", ".join(f"{r[0]} {r[k]:.0%}" for r in rows if r[0] in ("WMT", "USO", "NVDA", "META", "MSFT", "IWM", "IBIT", "MSTR", "TSLA")))
    # 2. his late overnight buys vs peers
    L = list(csv.DictReader(open(f"{B}/close_miss.csv")))
    jobs = []
    for r in L:
        m = his_min(r)
        jobs += [(s, r["date"], m, r["right"]) for s in set(SYMS) | {r["sym"]}]
    with mp.Pool(8) as pool: X = dict(pool.map(at, jobs, chunksize=20))
    out = []
    for r in L:
        m = his_min(r); me = X.get((r["sym"], r["date"], m, r["right"]))
        if not me: continue
        peers = [X.get((s, r["date"], m, r["right"])) for s in SYMS if s != r["sym"]]
        peers = [p for p in peers if p]
        rk = lambda k: round(100 * sum((p[k] if p[k] is not None else -9) < (me[k] if me[k] is not None else -9) for p in peers) / len(peers)) if peers else None
        out.append(dict(date=r["date"], time=r["time"], sym=r["sym"], right=r["right"], his_ret=float(r["his_ret"]), his_pnl=float(r["his_pnl"]), d2_30=float(r["d2_30"]), d2_max=float(r["d2_max"]),
                        held=round(me["held"], 3), d3=round(me["d3"], 3), last=None if me["last"] is None else round(me["last"], 3), d3_last=None if me["d3_last"] is None else round(me["d3_last"], 3),
                        swings=me["n"], rk_d3=rk("d3"), rk_d3_last=rk("d3_last")))
    with open(f"{B}/d3_his.csv", "w") as f:
        w = csv.DictWriter(f, list(out[0])); w.writeheader(); w.writerows(out)
    print(f"\n#### 2. His late (15:00+) overnight buys at his minute: {len(out)}\n\n| Group | n | D3 median | D3-last median | rank D3 | rank D3-last | D3-last >= 0.5 | D2 last 30 >= 0.5 |\n|---|---|---|---|---|---|---|---|")
    for g, f in (("all", lambda r: True), ("winners", lambda r: r["his_pnl"] > 0), ("losers", lambda r: r["his_pnl"] <= 0), ("giants 3x+", lambda r: r["his_ret"] >= 3)):
        Y = [r for r in out if f(r)]
        md = lambda k: st.median([r[k] for r in Y if r[k] is not None])
        print(f"| {g} | {len(Y)} | {md('d3'):.2f} | {md('d3_last'):.2f} | {md('rk_d3'):.0f} | {md('rk_d3_last'):.0f} | {sum((r['d3_last'] or -9) >= 0.5 for r in Y) / len(Y):.0%} | {sum(r['d2_30'] >= 0.5 for r in Y) / len(Y):.0%} |")
    for r in out:
        if r["his_ret"] >= 3: print("  giant", r["date"], r["time"], r["sym"], r["right"], f"{r['his_ret']:.1f}x", "D3", r["d3"], "D3-last", r["d3_last"], "ranks", r["rk_d3"], r["rk_d3_last"], "swings", r["swings"])
    # 3. all his entries
    H = list(csv.DictReader(open(f"{B}/his_tvd.csv")))
    with mp.Pool(8) as pool: Z = pool.map(at, [(h["sym"], h["date"], int(h["minute"]), h["right"]) for h in H], chunksize=10)
    E = [(h, x) for h, (_, x) in zip(H, Z) if x and x["d3_last"] is not None]
    print(f"\n#### 3. All his entries with a SPY swing before them: {len(E)} of {len(H)}\n\n| D3-last at his minute | entries | giants (3x+) | per 100 | won | his P&L |\n|---|---|---|---|---|---|")
    for a, b in ((-99, 0), (0, 0.5), (0.5, 1), (1, 99)):
        Y = [(h, x) for h, x in E if a <= x["d3_last"] < b]
        if not Y: continue
        g = sum(float(h["ret"]) >= 3 for h, _ in Y)
        print(f"| {a} to {b} | {len(Y)} | {g} | {100 * g / len(Y):.1f} | {sum(float(h['pnl']) > 0 for h, _ in Y) / len(Y):.0%} | ${sum(float(h['pnl']) for h, _ in Y):+,.0f} |")
    print("\n| D3 (all swings) at his minute | entries | giants | per 100 | won | his P&L |\n|---|---|---|---|---|---|")
    for a, b in ((-99, 0), (0, 0.5), (0.5, 1), (1, 99)):
        Y = [(h, x) for h, x in E if a <= x["d3"] < b]
        if not Y: continue
        g = sum(float(h["ret"]) >= 3 for h, _ in Y)
        print(f"| {a} to {b} | {len(Y)} | {g} | {100 * g / len(Y):.1f} | {sum(float(h['pnl']) > 0 for h, _ in Y) / len(Y):.0%} | ${sum(float(h['pnl']) for h, _ in Y):+,.0f} |")


if __name__ == "__main__":
    main()
