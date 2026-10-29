"""Risk tests on the champion (the user, 2026-10-27: "what else do you suggest to check to reduce the risk?" ... "yes
please test them"). One run, tune AND check (split.py), fair list + Favorites 24m, real quotes, 2% and 3%.

  0. diagnosis  the champion's 3 worst drops on each list and half: which trades, overnight or same day, which groups
  1. caps       trades that move together: at most N open positions on the same side in one group
                (grp1 / grp2), or at most N open on the same side in all (side2 / side3)
  2. house      overnight on house money: at the champion's carry on the entry day, sell enough at the close's bid to
                get the premium back (hm-back1), half of it back (hm-back05), or half the position (hm-half); hold the rest
  3. hedge      on a night the bot carries positions, buy a ~0.20-delta SPY option the other way at 15:59 for 5% /
                10% / 20% of the net carried value (hedge05 / hedge10 / hedge20), sold at 9:35 the next day
                (Alpaca bars fetched by hedge_fetch.py, the walk's +-2%, commission both ways; main legs only, the pyramid adds are not hedged)

Set before running: the versions above; the pick of each idea on tune by min(fair, Favorites) of log growth per point
of worst drop against the champion (a risk test: the same money at a smaller drop counts), the standard money pick
printed next to it; the verdict reads the pick's check numbers only.
The base is the champion of retry_roll.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes), without early entry.

  node --env-file=.env <dir>/run.mjs risk_tests.py      (from the app repo root)
"""
import collections, json, math, multiprocessing as mp, os, pickle, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from split import half
from store import day

B = "data/local/x/bt"
CAL = rr.CAL
SIZES = rr.SIZES
GROUPS = {
    "crypto": "MSTR IBIT COIN HOOD IREN CRCL",
    "semis": "SMCI ARM AMD AVGO QCOM NVDA MU INTC AAOI MRVL CRDO SOXX LITE AMBA TSEM SNDK SKHY DELL",
    "megatech": "META AAPL GOOGL MSFT AMZN TSLA NFLX",
    "software": "PLTR ORCL AI IBM CRWD ADBE CRM PANW SNOW NOW SHOP APP IGV CRWV NBIS",
    "spec": "IONQ QBTS RKLB ASTS OKLO ONDS",
    "fintech": "SOFI AFRM UPST NU XYZ LMND IBKR",
}
GROUP = {s: g for g, ss in GROUPS.items() for s in ss.split()}
CAPS = {"grp1": ("group", 1), "grp2": ("group", 2), "side2": ("side", 2), "side3": ("side", 3)}
HOUSE = ("hm-back1", "hm-back05", "hm-half")
HEDGE = {"hedge05": 0.05, "hedge10": 0.10, "hedge20": 0.20}
IDEAS = (("caps", tuple(CAPS)), ("house", HOUSE), ("hedge", tuple(HEDGE)))


def house(cost, steps, date, mode):
    """The steps with a sale at the entry day's carry (its close less the spread), the rest scaled down."""
    i = next((j for j, s in enumerate(steps) if s[2] == "carry" and s[0] == date), None)
    if i is None: return steps
    d, t, _, r, px, _ = steps[i]
    sold = sum(s[3] * s[4] for s in steps[:i] if s[2] == "sell")
    bid = max(px * (1 - sim.SH), 0.01)
    if mode == "hm-back1": x = max(0.0, cost - sold) / bid
    elif mode == "hm-back05": x = max(0.0, 0.5 * cost - sold) / bid
    else: x = r / 2
    x = min(r, x)
    if x <= 1e-9 or r <= 0: return steps
    f = (r - x) / r
    later = [(a, b, c, round(q * f, 4) if c in ("sell", "carry") else q, p, k) for a, b, c, q, p, k in steps[i:]]
    return steps[:i] + [(d, t, "sell", round(x, 4), round(bid, 4), "house")] + later


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    base = rr.leg(sym, date, m0, right, c)
    if not base: return None
    rcost, real, book = base
    sells = [s for s in real if s[2] == "sell"]
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8),
               base={s: sim.result(rcost, real, s) for s in SIZES} | {"h": {s: sim.result(rcost, real, s / 2) for s in SIZES}},
               over=int(any(s[0] != date for s in sells)), end=max((s[0], s[1]) for s in sells) if sells else (date, 389),
               carries=[(s[0], s[3] * s[4] / rcost) for s in real if s[2] == "carry"])
    if kind == "add": return out
    out["house"] = {v: {s: sim.result(rcost, house(rcost, real, date, v), s) for s in SIZES} for v in HOUSE}
    held = {}
    for mm in range(m0, 390):
        k = RB.quote(c[0], date, mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    out["held"] = held
    return out


def hedge_leg(job):
    """A ~0.20-delta SPY option bought at the close of night d, sold at 9:35 the next session: its return."""
    d, right = job
    try:
        spot = rr.closes("SPY", d)[389]
        if not spot: return job, None
        cands = cu.candidates("SPY", d, 389, right, spot)
        if not cands: return job, None
        c = min(cands, key=lambda x: abs(x[3] - 0.20))
        nd = CAL[CAL.index(d) + 1]
        b0 = sim.last_bar(day(c[0], d), 389, 10)
        b1 = [b for b in day(c[0], nd) if 5 <= b[0] <= 15]
        if not b0 or not b1: return job, None
        pin, pout = b0[4] * (1 + sim.SH), b1[0][4] * (1 - sim.SH)
        return job, pout / pin - 1 - 2 * sim.COMM / (pin * 100)
    except Exception:
        return job, None


def mains(R, src, part, a=""):
    return sorted((r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a),
                  key=lambda r: (r["date"], r["minute"]))


def kept(M, v):
    """The main trades a cap lets in, in entry order."""
    if v not in CAPS: return M
    how, n = CAPS[v]
    out, open_ = [], []
    for r in M:
        open_ = [o for o in open_ if o["end"] > (r["date"], r["minute"])]
        key = (GROUP.get(r["sym"], r["sym"]), r["right"]) if how == "group" else r["right"]
        same = [o for o in open_ if ((GROUP.get(o["sym"], o["sym"]), o["right"]) if how == "group" else o["right"]) == key]
        if len(same) >= n: continue
        out.append(r); open_.append(r)
    return out


def entries(R, adds, H, src, v, part, size, a=""):
    E = []
    M = kept(mains(R, src, part, a), v)
    for r in M:
        ret = r["house"][v][size] if v in HOUSE else r["base"][size]
        E.append((r["date"], r["minute"], 1.0, ret, r["over"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"]: continue
            share, up = r["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["base"]["h"][size], ad["over"]))
            break
    if v in HEDGE:
        cap = sim.NIGHT_CAP / size if sim.NIGHT_CAP else 1e9
        net = collections.defaultdict(float)
        for r in M:
            for d, u in r["carries"]: net[d] += (1 if r["right"] == "C" else -1) * min(u, cap)
        for d, x in net.items():
            hr = H.get((d, "P" if x > 0 else "C"))
            if abs(x) > 1e-9 and hr is not None: E.append((d, 389, HEDGE[v] * abs(x), hr, 1))
    return E


def score(s, b):
    """Log growth per point of worst drop, against the champion's."""
    g = lambda x: math.log(max(x["acct"], 1) / 1e5) / max(x["dd"], 0.01)
    return g(s) / g(b) if g(b) > 0 else 0


def diagnose(R, adds, src, part, size, a=""):
    E = sorted(entries(R, adds, {}, src, "base", part, size, a))
    M = {(r["date"], r["minute"]): r for r in mains(R, src, part, a)}
    eq, cur, start, curve, rows = 1e5, None, 1e5, [], []
    for e in E:
        if e[0] != cur: cur = e[0]; start = eq
        pnl = size * start * e[2] * max(-1, e[3]); eq += pnl
        rows.append((e, pnl)); curve.append((e[0], eq))
    # every drop from a high until the next high: (depth, index of the high, index of the low)
    eps, hi, ep = [], (1e5, -1), None
    for i, (_, x) in enumerate(curve):
        if x >= hi[0]:
            if ep: eps.append(ep)
            hi, ep = (x, i), None
        elif not ep or 1 - x / hi[0] > ep[0]: ep = (1 - x / hi[0], hi[1], i)
    if ep: eps.append(ep)
    eps = sorted(eps, reverse=True)[:3]
    print(f"\n#### {src} {part} {size:.0%}: the 3 worst drops")
    for dd, i0, i1 in eps:
        W = rows[i0 + 1:i1 + 1]
        night = sum(p for (e, p) in W if e[4]); same = sum(p for (e, p) in W if not e[4])
        g = collections.defaultdict(float); n = collections.Counter()
        days = collections.defaultdict(collections.Counter)
        for e, p in W:
            r = M.get((e[0], e[1]))
            if r: g[GROUP.get(r["sym"], "other")] += p; days[e[0]][r["right"]] += 1
        busy = sum(1 for c in days.values() if max(c.values()) >= 3)
        worst = sorted(((p, M.get((e[0], e[1]))) for e, p in W if M.get((e[0], e[1]))), key=lambda q: q[0])[:5]
        print(f"- {100 * dd:.0f}% from {curve[i0][0] if i0 >= 0 else "the start"} to {curve[i1][0]}: {len(W)} entries on {len(days)} days; overnight "
              f"{night:+,.0f}, same day {same:+,.0f}; days with 3+ entries on one side: {busy}; by group "
              + ", ".join(f"{k} {v:+,.0f}" for k, v in sorted(g.items(), key=lambda q: q[1])[:4])
              + "; worst: " + ", ".join(f"{r['sym']} {r['date']} {r['right']} {p:+,.0f}" for p, r in worst), flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    keep = os.environ.get("RT_KEEP")   # a pickle of the walked trades, to price the hedge again without walking
    if keep and os.path.exists(keep): R = pickle.load(open(keep, "rb"))
    else:
        with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
        if keep: pickle.dump(R, open(keep, "wb"))
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    nights = {(d, rt) for r in R if r["kind"] == "main" for d, _ in r["carries"] for rt in ("C", "P")}
    with mp.Pool(8) as pool: H = {k: v for k, v in pool.map(hedge_leg, sorted(nights), chunksize=4) if v is not None}
    print(f"SPY hedge legs priced: {len(H)} of {len(nights)} (night, side)", flush=True)
    for src, a in (("fair", ""), ("fav", FR.A24)):
        for part in ("tune", "check"): diagnose(R, adds, src, part, 0.02, a)
    V = ["base", *CAPS, *HOUSE, *HEDGE]
    out = {}
    for size in SIZES:
        for part in ("tune", "check"):
            for v in V:
                out[(size, part, v)] = [rr.stats(entries(R, adds, H, src, v, part, size, a), size) for src, a in (("fair", ""), ("fav", FR.A24))]
    print("\n### Tune and check side by side, real quotes, from $100,000 (end balance / worst drop; without the best 5)")
    for size in SIZES:
        print(f"\n#### {size:.0%}\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) | Trades tune (fair / fav) |\n|---|---|---|---|---|---|---|---|")
        for v in V:
            tf, tv = out[(size, "tune", v)]; cf, cv = out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} | {tf['trades']} / {tv['trades']} |", flush=True)
    picks = {}
    for name, group in IDEAS:
        b = out[(0.02, "tune", "base")]
        sc = lambda v: min(score(out[(0.02, "tune", v)][i], b[i]) for i in (0, 1))
        money = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
        best = max(group, key=sc)
        picks[name] = best
        bc, pc = out[(0.02, "check", "base")], out[(0.02, "check", best)]
        print(f"\nPicked on tune ({name}): {best} 🎯 (growth per point of drop vs the champion, min of the lists: {sc(best):.2f}; "
              f"money pick {max(group, key=money)}). Check at 2%: fair ${pc[0]['acct']:,} / {pc[0]['dd']:.0%} vs ${bc[0]['acct']:,} / {bc[0]['dd']:.0%}, "
              f"Favorites ${pc[1]['acct']:,} / {pc[1]['dd']:.0%} vs ${bc[1]['acct']:,} / {bc[1]['dd']:.0%}; growth per drop vs the champion "
              f"{score(pc[0], bc[0]):.2f} / {score(pc[1], bc[1]):.2f}", flush=True)
    json.dump({"picks": picks, "out": {f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}}, open(f"{B}/risk_tests_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
