"""The D2 entry over a longer window and lower t (the user, 2026-10-27: "can we go with D2 for the last 2 hours? except
the 15 minutes of the openning.. also try it with t>=0.8/0.6 as well"; the 2-hour window = D2 summed over the last 120
minutes, the first 15 minutes of the session never in it). On the champion (the pyramid, IBIT down to $0.10, no cheap
fallback), real quotes; only the entry changes. Set before running (defence_signals.py, D2 >= 1.5 everywhere):
  c12_15       the champion: t >= 1.8, or t >= 1.2 and D2 (30 minutes) >= 1.5
  c8_15/c6_15  the D2 arm at t >= 0.8 / 0.6, 30 minutes
  w120         t >= 1.2, D2 over 120 minutes without 09:30-09:45
  c8w120/c6w120  both
Signals: the fair list's trade files sg_<rule> (score_round.py) and the Favorites' lists.py runs fav69_d2<tag> (today's
69 Favorites, 24 months). Tune / check by entry week (split.py). `book` = the share of trades with every fill on the
real book (a new entry minute may have no cached quote; such a fill keeps its +-2% price).

  node --env-file=.env <dir>/run.mjs d2_window.py      (from the app repo root)
-> data/local/x/bt/d2_window_summary.json
"""
import collections, csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import fair_fill as FF
import fav_real as FR
import floor_exception as fe
import real_bench as RB
from score_sum import account
from split import half

B = "data/local/x/bt"
V = {"c12_15": ("c12_15", None), "c8_15": ("c8_15", "c8"), "c6_15": ("c6_15", "c6"), "w120": ("c12_15w120", "w120"),
     "c8w120": ("c8_15w120", "c8w120"), "c6w120": ("c6_15w120", "c6w120")}
STATUS = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}
# the volume-weighted signal (the user, 2026-10-27: "more weight to a big size burst and ... on the against spy by
# volume"; defence_signals.py BT_VWEIGHT / BT_VW_PARTS): DW_SET=vw
if os.environ.get("DW_SET") == "vw":
    V = {"c12_15": ("c12_15", None), "vw": ("c12_15vw", "vw"), "vw-sqrt": ("c12_15vws", "vws"), "vw-t": ("c12_15vwt", "vwt"), "vw-d2": ("c12_15vwd", "vwd")}


def fav_signals(tag):
    if tag is None: return FR.signals("25")
    out = []
    for f in sorted(glob.glob(f"{B}/list_fav69_d2{tag}_*.json")):
        for r in json.load(open(f)):
            st = STATUS.get(r["status"])
            if st: out.append(dict(r, status=st, minute=str(r["minute"])))
    return out


def one(job):
    v, src, kind, t = job
    r = FF.one((src, kind, t))
    if not r: return None
    r.pop("path", None)
    cov = all(RB.quote(r["contract"], s[0], max(s[1] - 1, 0)) for s in r["steps"] if s[2] in ("buy", "sell"))
    return dict(r, v=v, cov=int(cov))


SIZE = float(os.environ.get("DW_SIZE", "0.02"))   # 2% a trade by default (the user, 2026-10-27); an add: half at half


def entries(R, adds, v, src, part, a=""):
    E = []
    for r in R:
        if r["v"] != v or r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        E.append((r["date"], r["minute"], 1.0, sim.result(r["paid"], r["steps"], SIZE), r["sym"], r["cov"], r["d2"]))
        if not r["d2"]: continue
        for x in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if x["minute"] <= r["minute"]: continue
            share, up = r["held"].get(x["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((x["date"], x["minute"], 0.5, sim.result(x["paid"], x["steps"], SIZE / 2), x["sym"], x["cov"], 0))
            break
    return E


def stats(E):
    R = sorted(E)
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[3]))) for e in R]
    acct, dd = account(pnl, SIZE)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], SIZE)
    d2 = [e for e in R if e[6]]
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), d2=len(d2),
                d2_per=round(sum(1e4 * max(-1, e[3]) for e in d2) / max(1, len(d2))), book=round(sum(e[5] for e in R) / max(1, len(R)), 3))


def main():
    jobs = []
    for v, (rule, tag) in V.items():
        jobs += [(v, "fair", "main", t) for t in fe.fair_signals(f"sg_{rule}")]
        jobs += [(v, "fav", "main", t) for t in fav_signals(tag)]
    jobs += [("add", "fair", "add", t) for t in fe.fair_signals("s_t18r15")] + [("add", "fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    print(f"\n### Tune weeks, real quotes, {SIZE:.0%} from $100,000\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) | D2 entries (fair / fav) | D2 per trade at $10K (fair / fav) | Fully on the book (fair / fav) |\n|---|---|---|---|---|---|---|")
    for v in V:
        f, g = stats(entries(R, adds, v, "fair", "tune")), stats(entries(R, adds, v, "fav", "tune", FR.A24))
        out[f"tune|{v}"] = dict(fair=f, fav=g)
        print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} | {f['d2']} / {g['d2']} | "
              f"{f['d2_per']:+,} / {g['d2_per']:+,} | {f['book']:.0%} / {g['book']:.0%} |", flush=True)
    base = out["tune|c12_15"]
    score = lambda v: min(out[f"tune|{v}"]["fair"]["acct"] / base["fair"]["acct"], out[f"tune|{v}"]["fav"]["acct"] / base["fav"]["acct"])
    best = max(list(V)[1:], key=score)
    print(f"\nPicked on tune: {best}; better than the champion on both tune lists: {score(best) > 1}\n")
    print("### Check weeks, one run\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) | Fully on the book |\n|---|---|---|---|---|")
    for v in ("c12_15", best):
        f, g = stats(entries(R, adds, v, "fair", "check")), stats(entries(R, adds, v, "fav", "check", FR.A24))
        out[f"check|{v}"] = dict(fair=f, fav=g)
        print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} | {f['book']:.0%} / {g['book']:.0%} |", flush=True)
    out["best"] = best
    json.dump(out, open(f"{B}/d2_window_summary{'_' + os.environ['DW_SET'] if os.environ.get('DW_SET') else ''}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
