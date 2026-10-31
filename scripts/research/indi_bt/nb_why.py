"""Why nights have no bet (nightly-bet r2 rules: top 10% of range, no earnings, no Friday, next-day expiry), fair list
and Favorites, all weeks. Each night: the stock-sides passing the stock filters ranked by t; walk down the ranking and
record why each fails to become a trade, until 2 trade. Shows the reasons, and how many nights would reach 2 if the
rule went down the list instead of stopping at the top 2."""
import collections, datetime as dt, multiprocessing as mp, os, sys
os.environ["IC_SET"] = "many"
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import indi_close as ic, sim, cheap_up as cu, real_bench as RB, fill_models as fm, retry_roll as rr, fav_real as FR
from indi_close import features, ath_flags, candidates, VERSIONS, A0, Z, M_IN
from low_delta import HIS40, PRIOR
from store import day

def why(job):
    src, r, right = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    d0 = dt.date.fromisoformat(r["date"]); first = d0.replace(day=1); nxt = (first + dt.timedelta(days=32)).replace(day=1)
    exps = set()
    for m0 in (first, nxt):
        k = (r["sym"], m0.isoformat()[:7])
        if k not in sim._exp: sim._exp[k] = sim.expiries(r["sym"], m0.isoformat(), (m0 + dt.timedelta(days=40)).isoformat())
        exps |= set(sim._exp[k])
    a = rr.CAL[rr.CAL.index(r["date"]) + 1]
    if a not in exps: return "no next-day expiry"
    c = ic.pick(r, right, 0.20, "next")
    if not c: return "next-day option too thin or < $0.20"
    w = ic.walk((src, r, right, 0.20, "next", "his"))
    return "trade" if w else "no price at buy / next morning"

if __name__ == "__main__":
    days = [d for d in rr.CAL if A0 <= d <= Z and rr.CAL.index(d) + 1 < len(rr.CAL)]
    jobs = [("fair", s, d) for d in days for s in sorted(HIS40) if s in PRIOR[d[:4]] and d <= RB.LAST]
    jobs += [("fav", s, d) for d in days if d >= FR.A24 for s in sorted(FR.FAV)]
    with mp.Pool(8) as pool: rows = [x for x in pool.map(features, jobs, chunksize=50) if x]
    ath_flags(rows)
    V = {**VERSIONS["r2"], "n": 99}
    P = candidates(rows, V)
    work = [(src, r, right) for (src, d), lst in P.items() for r, right in lst]
    print(len(work), "candidates to check", flush=True)
    with mp.Pool(8) as pool: res = dict(zip([(s, r["date"], r["sym"], rt) for s, r, rt in work], pool.map(why, work, chunksize=4)))
    for src in ("fair", "fav"):
        nights = [d for d in days if (src == "fair" or d >= FR.A24) and d <= RB.LAST and dt.date.fromisoformat(d).weekday() != 4]
        cnt_c = collections.Counter(); top2 = collections.Counter(); deep = collections.Counter(); reasons = collections.Counter(); ncand = []
        for d in nights:
            lst = P.get((src, d), [])
            ncand.append(len(lst))
            if not lst: cnt_c["no stock passes the filters"] += 1; continue
            out = [res[(src, d, r["sym"], rt)] for r, rt in lst]
            for o in out: reasons[o] += 1
            top2[min(2, sum(o == "trade" for o in out[:2]))] += 1
            deep[min(2, sum(o == "trade" for o in out))] += 1
        n = len(nights)
        print(f"\n## {src}: {n} nights (no Fridays)")
        print(f"nights with no stock passing the filters: {cnt_c['no stock passes the filters']} ({cnt_c['no stock passes the filters'] / n:.0%}); candidates a night median {sorted(ncand)[n // 2]}")
        print("each candidate's fate:", {k: f"{v} ({v / sum(reasons.values()):.0%})" for k, v in reasons.most_common()})
        print(f"top 2 only (as tested): 0 / 1 / 2 bets = {top2[0] + cnt_c['no stock passes the filters']} / {top2[1]} / {top2[2]} nights")
        print(f"going down the list:    0 / 1 / 2 bets = {deep[0] + cnt_c['no stock passes the filters']} / {deep[1]} / {deep[2]} nights")
