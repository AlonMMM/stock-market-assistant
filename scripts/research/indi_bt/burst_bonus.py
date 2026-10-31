"""A volume burst that makes the stock independent of SPY (the user, 2026-10-27, on CBRS: "she got huge volume at once
and the price jump like hell. After that she moved better than the spy and start to be independed ... When burst of
valume comes in and make the ticker independed its a good news and should be treaded as bonus or somthing").
Set before running:
  burst         a 1-minute bar with volume >= VX x the stock's usual for that minute (the median of the same minute over
                the 20 sessions before) and a move >= MV x S30 (levels.py) in one direction; VX / MV 8 / 0.5 and 15 / 1.0
  independent   W minutes later (15 / 30) the stock's move since the burst's close beats SPY x beta by 0.25 S30 or more
                in the burst's direction
  (A) entry     a new trade on the burst's side at that minute (up to 15:44), on stock-days the champion has not traded,
                the champion's pick (IBIT down to $0.10, no cheap fallback) and exits; +-2% fills (sim.py) with the share of
                fills on the real book shown, a screen before buying quotes
  (B) bonus     the champion's own trades whose signal comes after a confirmed burst on the same side that day: 1.5x size,
                real quotes
Tune / check by entry week (split.py), the fair list and the Favorites 24 months, at 2% a trade (the user's default).

  node --env-file=.env <dir>/run.mjs burst_bonus.py      (from the app repo root)
-> data/local/x/bt/burst_bonus_summary.json
"""
import collections, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from levels import ctx
from low_delta import HIS40, PRIOR
from score_sum import account, held as booked
from signals import series, beta
from split import half
from store import calendar, day

B = "data/local/x/bt"
CAL = calendar()
IDX = {d: i for i, d in enumerate(CAL)}
SIZE = 0.02
BURSTS = {"8x/0.5": (8, 0.5), "15x/1.0": (15, 1.0)}
WAITS = (15, 30)


def events(job):
    """Confirmed bursts of one stock-day: [(burst level, wait, minute confirmed, side)]."""
    src, sym, date = job
    i = IDX.get(date)
    if i is None or i < 21: return []
    bars = day(sym, date)
    if len(bars) < 300: return []
    cx = ctx(sym, date)
    b_ = beta(sym, date, i, CAL)
    if not cx or not cx["sd"] or b_ is None: return []
    usual = [[] for _ in range(390)]
    for d in CAL[i - 20:i]:
        for x in day(sym, d):
            if 0 <= x[0] < 390: usual[x[0]].append(x[5])
    med = [st.median(u) if len(u) >= 10 else None for u in usual]
    c, spy = series(bars)[0], series(day("SPY", date))[0]
    vol = [0] * 390
    for x in bars: vol[x[0]] = x[5]
    out, seen = [], set()
    for m in range(10, 375):
        if not (c[m] and c[m - 1] and med[m]): continue
        move = (c[m] / c[m - 1] - 1) / cx["sd"]
        for name, (vx, mv) in BURSTS.items():
            if vol[m] < vx * med[m] or abs(move) < mv: continue
            side = 1 if move > 0 else -1
            for w in WAITS:
                e = m + w
                if (name, w) in seen or e > 374 or not (c[e] and spy[m] and spy[e]): continue
                ex = (c[e] / c[m] - 1) - b_ * (spy[e] / spy[m] - 1)
                if side * ex / cx["sd"] >= 0.25:
                    seen.add((name, w))
                    out.append(dict(src=src, sym=sym, date=date, burst=name, wait=w, minute=e, burst_minute=m, right="C" if side > 0 else "P", price=c[e]))
    return out


def trade(ev):
    """(A): the new entry, the champion's pick and exits, +-2% fills; with the share of fills on the real book."""
    if RB.DBX != fm.DBX[ev["src"]]: RB.DBX = fm.DBX[ev["src"]]; RB.Q.clear()
    cands = cu.candidates(ev["sym"], ev["date"], ev["minute"], ev["right"], ev["price"])
    p = fe.choose(cands, 0.10 if ev["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(ev["sym"], ev["date"], ev["minute"], ev["right"], c[0], c[1], CAL)
    if cost is None: return None
    fills = [s for s in steps if s[2] in ("buy", "sell")]
    cov = sum(bool(RB.quote(c[0], s[0], max(s[1] - 1, 0))) for s in fills) / len(fills)
    return dict(ev, r=sim.result(cost, steps, SIZE), cov=cov, h=booked(cost, steps))


def book(r, k):
    """score_sum.held of a leg, its marks at k times the size (as its pnl)."""
    h = booked(r["paid"], r["steps"])
    return dict(h, marks={d: k * x for d, x in h["marks"].items()})


def acct(E):
    R = sorted(E, key=lambda e: e[:4])
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[3])), **e[4]) for e in R]
    a, dd = account(pnl, SIZE)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], SIZE)
    return dict(acct=round(a), dd=round(dd, 3), no5=round(a5), trades=len(R))


def main():
    # the champion's trades on real quotes, at 2% (fair_fill.py's legs: main + the pyramid's adds)
    import fair_fill as FF
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    with mp.Pool(8) as pool: R = [r for r in pool.map(FF.one, jobs, chunksize=4) if r]
    # every stock-day of the two lists: the fair list's stocks of each year, the Favorites' stocks over 24 months
    days = {(r["src"], r["sym"], r["date"]) for r in R}
    days |= {("fair", s, d) for d in CAL if "2024-02-01" <= d <= RB.LAST for s in HIS40 if s in PRIOR[d[:4]]}
    fav_syms = sorted({r["sym"] for r in R if r["src"] == "fav"})
    days = sorted(days | {("fav", s, d) for d in CAL if FR.A24 <= d <= "2026-10-23" for s in fav_syms})
    print(len(days), "stock-days to scan", flush=True)
    with mp.Pool(8) as pool: EV = [e for es in pool.map(events, days, chunksize=16) for e in es]
    print(len(EV), "confirmed bursts", collections.Counter((e["burst"], e["wait"]) for e in EV), flush=True)
    champ_days = {(r["src"], r["sym"], r["date"]) for r in R if r["kind"] == "main"}
    newA = [e for e in EV if (e["src"], e["sym"], e["date"]) not in champ_days]
    with mp.Pool(8) as pool: TA = [t for t in pool.map(trade, newA, chunksize=4) if t]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)

    def champ(src, part, a="", bonus=None):
        """The champion's legs (E rows); bonus=(burst, wait): 1.5x on a signal after a confirmed burst on its side."""
        conf = collections.defaultdict(list)
        if bonus:
            for e in EV:
                if (e["burst"], e["wait"]) == bonus and e["src"] == src: conf[(e["sym"], e["date"], e["right"])].append(e["minute"])
        E = []
        for r in R:
            if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
            k = 1.5 if any(mm <= r["minute"] for mm in conf.get((r["sym"], r["date"], r["right"]), [])) else 1.0
            E.append((r["date"], r["minute"], k, sim.result(r["paid"], r["steps"], SIZE * k), book(r, k)))
            if not r["d2"]: continue
            for x in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
                if x["minute"] <= r["minute"]: continue
                share, up = r["held"].get(x["minute"], (0, None))
                if share > 0 and up is not None and up > 0: E.append((x["date"], x["minute"], 0.5 * k, sim.result(x["paid"], x["steps"], SIZE * 0.5 * k), book(x, 0.5 * k)))
                break
        return E

    out = {}
    lists = (("fair", ""), ("fav", FR.A24))
    print("\n### Tune weeks, 2% a trade from $100,000 (the champion on real quotes; (A)'s new trades on +-2% fills)\n")
    print("| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) | Trades changed (fair / fav) | Their P&L at $10K a unit (fair / fav) | Fully on the book |\n|---|---|---|---|---|---|---|")
    base = {src: acct(champ(src, "tune", a)) for src, a in lists}
    print(f"| champion | ${base['fair']['acct']:,} / {base['fair']['dd']:.0%} | ${base['fav']['acct']:,} / {base['fav']['dd']:.0%} | ${base['fair']['no5']:,} / ${base['fav']['no5']:,} | | | |")
    out["tune|base"] = base
    for name in BURSTS:
        for w in WAITS:
            res, n, pl, cov = {}, {}, {}, {}
            for src, a in lists:
                new = [t for t in TA if t["src"] == src and (t["burst"], t["wait"]) == (name, w) and half(t["date"]) == "tune" and t["date"] >= a]
                E = champ(src, "tune", a) + [(t["date"], t["minute"], 1.0, t["r"], t["h"]) for t in new]
                res[src], n[src], pl[src] = acct(E), len(new), round(sum(1e4 * max(-1, t["r"]) for t in new))
                cov[src] = round(sum(t["cov"] == 1 for t in new) / max(1, len(new)), 2)
            out[f"tune|A|{name}|{w}"] = dict(res=res, n=n, pnl=pl)
            print(f"| (A) entry {name}, {w} min | ${res['fair']['acct']:,} / {res['fair']['dd']:.0%} | ${res['fav']['acct']:,} / {res['fav']['dd']:.0%} | ${res['fair']['no5']:,} / ${res['fav']['no5']:,} | {n['fair']} / {n['fav']} | {pl['fair']:+,} / {pl['fav']:+,} | {cov['fair']:.0%} / {cov['fav']:.0%} |", flush=True)
            res = {src: acct(champ(src, "tune", a, (name, w))) for src, a in lists}
            nb = {src: sum(1 for e in champ(src, "tune", a, (name, w)) if e[2] in (1.5, 0.75)) for src, a in lists}
            out[f"tune|B|{name}|{w}"] = dict(res=res, n=nb)
            print(f"| (B) 1.5x after {name}, {w} min | ${res['fair']['acct']:,} / {res['fair']['dd']:.0%} | ${res['fav']['acct']:,} / {res['fav']['dd']:.0%} | ${res['fair']['no5']:,} / ${res['fav']['no5']:,} | {nb['fair']} / {nb['fav']} | | 100% |", flush=True)
    score = lambda k: min(out[k]["res"]["fair"]["acct"] / base["fair"]["acct"], out[k]["res"]["fav"]["acct"] / base["fav"]["acct"])
    best = max((k for k in out if k != "tune|base"), key=score)
    print(f"\nPicked on tune: {best}; better than the champion on both tune lists: {score(best) > 1}\n")
    _, kind, name, w = best.split("|"); w = int(w)
    print("### Check weeks, one run\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) |\n|---|---|---|---|")
    cb = {src: acct(champ(src, "check", a)) for src, a in lists}
    if kind == "A":
        cv = {src: acct(champ(src, "check", a) + [(t["date"], t["minute"], 1.0, t["r"], t["h"]) for t in TA if t["src"] == src and (t["burst"], t["wait"]) == (name, w) and half(t["date"]) == "check" and t["date"] >= a]) for src, a in lists}
    else:
        cv = {src: acct(champ(src, "check", a, (name, w))) for src, a in lists}
    for lab, x in (("champion", cb), (best, cv)):
        print(f"| {lab} | ${x['fair']['acct']:,} / {x['fair']['dd']:.0%} | ${x['fav']['acct']:,} / {x['fav']['dd']:.0%} | ${x['fair']['no5']:,} / ${x['fav']['no5']:,} |", flush=True)
    out["check"] = dict(base=cb, best=cv, pick=best)
    json.dump(out, open(f"{B}/burst_bonus_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
