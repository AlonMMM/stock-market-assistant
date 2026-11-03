"""Fills bigger than the book shows, on the champion 2.10 (the user, 2026-11-03: "Why are we looking on volume and not ask
bid size?", "Does the test use ask and bid size when filling?", "Yes"). An analysis of the fill model, not a rule.
The walk (opt_spread.price on real_bench.quote) fills the whole order at one price and never reads the book's size. Here
every buy and sale of thin_strike.py's champ (size_volume t3A-c5: the 0.15 pick with 200 contracts, 2.9's exits, the
volume tiers, the pyramid add within 5%) keeps the book it was priced on with its sizes (real_bench.quote_sz, the same
row); the order's contracts come from the account at that moment (pct x the day's account x the tier weight / the price
paid; the add rows are already half size). The contracts above the shown size (the ask size on a buy, the bid size on a
sale) pay more, set before running:
  base   as now (reproduces the champion)
  T1     one tick worse ($0.01 under $3, $0.05 from $3)
  SP     the full spread worse (a sale floored at $0.01)
  SP2    SP, and each further multiple of the shown size another spread, at most 3 spreads (a crude book walk)
A size of 0 reads 1 (counted); a fill with no book (the bar model, a stop priced at its second without a book) pays
nothing extra (counted). The exits stay on the price paid by the walk (the extra cost does not move the stops). The
cbbo-1m book is the top of the book only, so the cost of the contracts above it is a range, not a price. Flat 2% / 3%
from $100,000 as the benchmark (the live bot's sizeSteps lower the size from $300K: real orders are smaller there).
Lists: the fair list + the Favorites (24 months); tune = even entry weeks, check = odd (split.py), the same run.

  node --env-file=.env <dir>/run.mjs size_fill.py      (from the app repo root)
-> data/local/x/bt/size_fill_summary.json
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS
import size_volume as SV
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from score_sum import held as booked
from split import half

B = "data/local/x/bt"
MODELS = ("base", "T1", "SP", "SP2")


def books(c, steps):
    """The book each buy and sale of opt_spread.price(steps, c, cost, "bid") was priced on: one (bid, ask, bid_sz,
    ask_sz) or None per step, in step order."""
    out = []
    for d, m, side, q, px, rule in steps:
        if side not in ("buy", "sell"): out.append(None); continue
        at = max(m - 1, 0)
        k = RB.quote_sz(c, d, at)
        if rule.endswith("_1s") or not k or side == "sell": out.append(k); continue
        bid, ask = k[0], k[1]
        p = (bid + ask) / 2 + (ask - (bid + ask) / 2) / 2
        later = RB.quote_sz(c, d, at + 1)
        out.append(later if later and later[0] > p else k)
    return out


def walk_c(t, m, c):
    """thin_strike.walk_c, keeping the real fills with their books."""
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], TS.CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], TS.CAL, paid=rcost)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    row = dict(r1=sim.result(rcost, real, 0.01), r2=sim.result(rcost, real, 0.02), r3=sim.result(rcost, real, 0.03),
               r15=sim.result(rcost, real, 0.015), over=int(any(s[2] == "carry" for s in steps)), h=booked(rcost, real))
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    row["held"] = {}
    for mm in range(m, 390):
        k = RB.quote(c[0], t["date"], mm)
        row["held"][mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    row["paid"] = rcost
    row["fills"] = [(s[2], s[3], s[4], s[5], bk) for s, bk in zip(real, books(c[0], steps)) if s[2] in ("buy", "sell")]
    return row


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear(); RB.SZ.clear()
    m0, spot = int(t["minute"]), float(t["price"])
    floor = 0.10 if t["sym"] == "IBIT" else 0.20
    p = TS.pick(cu.candidates(t["sym"], t["date"], m0, t["right"], spot), floor, "champ", t["sym"], t["right"], spot)
    if not p: return None
    c = p[0]
    row = walk_c(t, m0, c)
    if row is None: return None
    return dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v={"champ": row},
                pick={"champ": dict(contract=c[0], price=c[4], vol30=c[5])})


def entries(R, adds, src, part, size, a=""):
    """thin_strike.entries for champ, each row with its walk: (date, minute, weight, r, over, h, walk)."""
    full, halfk = TS.SIZES[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        x, m = r["v"]["champ"], r["minute"]
        w = TS.t3A(r["rvol"])
        E.append((r["date"], m, w, x[full], x["over"], x["h"], x))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            aw = min(0.5 * w, max(0.0, 0.05 / size - w))
            y = ad["v"]["champ"]
            if share > 0 and up is not None and up > 0 and aw > 0: E.append((ad["date"], ad["minute"], aw, y[halfk], y["over"], y["h"], y))
            break
    return E


def extra(model, side, n, px, bk, tally):
    """Dollars above the walk's price for n contracts on book bk (top of the book only)."""
    if n <= 0 or model == "base": return 0.0, 0.0, None
    if bk is None: tally["nobook"] += 1; return 0.0, 0.0, None
    bid, ask, bsz, asz = bk
    shown = asz if side == "buy" else bsz
    if shown <= 0: tally["zero"] += 1; shown = 1
    over = max(0.0, n - shown)
    if over <= 0: return 0.0, 0.0, n / shown
    spread = max(0.0, ask - bid)
    if model == "T1": per = [(over, 0.01 if px < 3 else 0.05)]
    elif model == "SP": per = [(over, spread)]
    else: per = [(min(over, shown), spread), (min(max(over - shown, 0), shown), 2 * spread), (max(over - 2 * shown, 0), 3 * spread)]
    usd = 0.0
    for k, add in per:
        if side == "sell": add = min(add, max(0.0, px - 0.01))
        usd += k * add * 100
    return usd, over, n / shown


def account(E, pct, model, tally, diag=None):
    """size_volume.account on the rows of entries(), the extra fill cost of `model` taken off each row at the size the
    account gives it on its entry day (the buy's part off its marks while held). -> (end, worst drop, [r after cost])."""
    R = sorted(range(len(E)), key=lambda i: E[i][:5])
    by = collections.defaultdict(list)
    for i in R: by[E[i][0]].append(i)
    days = sorted(set(by) | {E[i][5]["exit_day"] or E[i][0] for i in R})
    eq, peak, dd, open_, prev = 1e5, 1e5, 0.0, [], None
    after = {}
    for d in days:
        base = eq + sum(stake * E[i][2] * E[i][5]["marks"].get(prev, 0.0) - xb for stake, i, xb, xa in open_)
        for i in by.get(d, []):
            stake = pct * base
            date, m, w, r, over_, h, x = E[i]
            n = stake * w / (x["paid"] * 100)
            xb = xa = 0.0
            for side, q, px, rule, bk in x["fills"]:
                usd, over, ratio = extra(model, side, q * n, px, bk, tally)
                if side == "buy": xb += usd
                else: xa += usd
                if diag is not None and ratio is not None:
                    diag.append(dict(side=side, ratio=ratio, over=over > 0, year=date[:4], acct=base, giant=r >= 3.0))
            after[i] = max(-1, r) - (xb + xa) / (stake * w)
            open_.append((stake, i, xb, xa))
        keep = []
        for stake, i, xb, xa in open_:
            if (E[i][5]["exit_day"] or E[i][0]) == d: eq += stake * E[i][2] * max(-1, E[i][3]) - xb - xa
            else: keep.append((stake, i, xb, xa))
        open_ = keep
        now = eq + sum(stake * E[i][2] * E[i][5]["marks"].get(d, 0.0) - xb for stake, i, xb, xa in open_)
        peak = max(peak, now); dd = max(dd, 1 - now / peak); prev = d
    eq += sum(stake * E[i][2] * max(-1, E[i][3]) - xb - xa for stake, i, xb, xa in open_)
    return eq, dd, after


def stats(E, size, model, tally, diag=None):
    acct, dd, after = account(E, size, model, tally, diag)
    usd = [1e4 * E[i][2] * after[i] for i in range(len(E))]
    cost = [1e4 * E[i][2] * (max(-1, E[i][3]) - after[i]) for i in range(len(E))]
    top = sorted(range(len(E)), key=lambda i: -1e4 * E[i][2] * max(-1, E[i][3]))[:5]
    a5, _, _ = account([e for i, e in enumerate(E) if i not in set(top)], size, model, collections.Counter())
    giants = {i for i in range(len(E)) if E[i][3] >= 3.0}
    years = collections.defaultdict(float)
    for e, u in zip(E, usd): years[e[0][:4]] += u
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(E), win=round(sum(u > 0 for u in usd) / max(1, len(E)), 3),
                median=round(st.median(usd)) if usd else 0, giants=len(giants),
                nongiant=round(sum(u for i, u in enumerate(usd) if i not in giants)),
                cost_giants=round(sum(cost[i] for i in giants)), cost_rest=round(sum(c for i, c in enumerate(cost) if i not in giants)),
                years={y: round(x) for y, x in sorted(years.items())})


def table(R, adds, part, out):
    for size in TS.SIZES:
        print(f"\n### {part} weeks, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Model | List | Trades | Winners | Median at $10K | End / worst drop | vs base | Without the best 5 | Giants · non-giant sum | Extra cost at $10K: giants · rest | By year | No book · size 0 |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for model in MODELS:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                E = entries(R, adds, src, part, size, a)
                tally = collections.Counter()
                s = stats(E, size, model, tally)
                s["nobook"], s["zero"] = tally["nobook"], tally["zero"]
                out[f"{part}|{model}|{src}|{size}"] = s
                base = out[f"{part}|base|{src}|{size}"]["acct"]
                if model == "base":
                    ref = SV.stats([e[:6] for e in E], size)
                    s["sv_acct"] = ref["acct"]
                    print(f"<!-- base vs size_volume.stats: {s['acct']} vs {ref['acct']}, drop {s['dd']} vs {ref['dd']} -->", flush=True)
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {model} | {src} | {s['trades']} | {s['win']:.0%} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | {s['acct'] / base - 1:+.1%} | ${s['no5']:,} | {s['giants']} · {s['nongiant']:+,} | {s['cost_giants']:+,} · {s['cost_rest']:+,} | {yrs} | {s['nobook']} · {s['zero']} |", flush=True)


def sizes(R, adds, out):
    """How big the order is against the shown size: all weeks, at 2% and 3%, both lists."""
    print("\n### The order against the size the book shows (all weeks; order = contracts of that fill, shown = ask size on a buy, bid size on a sale)\n")
    print("| Size | List | Group | Fills | Buys above the shown size | Sales above | Median order / shown: buys · sales | 90th pct buys |")
    print("|---|---|---|---|---|---|---|---|")
    for size in TS.SIZES:
        for src, a in (("fair", ""), ("fav", FR.A24)):
            diag = []
            for part in ("tune", "check"): account(entries(R, adds, src, part, size, a), size, "SP", collections.Counter(), diag)
            groups = [("all", lambda x: True)]
            groups += [(y, lambda x, y=y: x["year"] == y) for y in sorted({x["year"] for x in diag})]
            groups += [("account < $300K", lambda x: x["acct"] < 3e5), ("$300K - $1M", lambda x: 3e5 <= x["acct"] < 1e6), ("account > $1M", lambda x: x["acct"] >= 1e6)]
            groups += [("giants (+300%)", lambda x: x["giant"]), ("the rest", lambda x: not x["giant"])]
            for name, f in groups:
                g = [x for x in diag if f(x)]
                bu = [x for x in g if x["side"] == "buy"]; se = [x for x in g if x["side"] == "sell"]
                if not g: continue
                s = dict(fills=len(g), buys_over=round(sum(x["over"] for x in bu) / max(1, len(bu)), 3),
                         sells_over=round(sum(x["over"] for x in se) / max(1, len(se)), 3),
                         ratio_buy=round(st.median(x["ratio"] for x in bu), 2) if bu else None,
                         ratio_sell=round(st.median(x["ratio"] for x in se), 2) if se else None,
                         p90_buy=round(sorted(x["ratio"] for x in bu)[int(0.9 * (len(bu) - 1))], 2) if bu else None)
                out[f"size|{size}|{src}|{name}"] = s
                print(f"| {size:.0%} | {src} | {name} | {s['fills']} | {s['buys_over']:.0%} | {s['sells_over']:.0%} | {s['ratio_buy']} · {s['ratio_sell']} | {s['p90_buy']} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", out)
    table(R, adds, "check", out)
    sizes(R, adds, out)
    json.dump(out, open(f"{B}/size_fill_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
