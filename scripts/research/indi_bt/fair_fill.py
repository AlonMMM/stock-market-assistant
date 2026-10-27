"""Buy near the option's fair price, not near the ask (the user, 2026-10-27: "can we calculate the real stock equity
before we buy? for exampl stock with spread of 1.0-1.2 (20%) might have a real price of 1.03 because this is what the
market maker use to calculat. if we add a order with 1.06 which is behind the mid we probably get it done no? ...
start with couple of click above the value it might gain a lot"; "do it all"). On the champion (2.5 + IBIT down to
$0.10 + the pyramid), real quotes; the sales stay as they are (the bid). At each buy, the book at the decision (the end
of the minute before the fill bar, real_bench's convention):
  fair "micro"  the size-weighted price: (bid x ask size + ask x bid size) / (bid size + ask size)
  fair "chain"  Black-Scholes at the stock's price then, with the IV read off the two neighbouring strikes' mids at the
                same minute, interpolated at our strike (only where both neighbours have a quote)
Step 1: where fair sits in the spread at our entries, (fair - mid) / half the spread, and whether it differs between
the trades that win and the ones that lose.
Step 2, set before running: a limit at fair + 0 / 1 / 2 / 3 ticks ($0.01 under $3, $0.05 from $3), never above what
the bot pays now (the mid + half the way to the ask); it waits 1 / 2 / 3 minutes; it fills only when the option
trades at or below the limit in that time (a 1-minute bar's low) or the book's ask comes down to it. Not filled:
"skip" (no trade) or "chase" (the bot's usual price on the book at the end of the wait, with the fill model's runaway
rule: the next minute's ask, at most +10%, when its bid is already above). A buy whose first sale comes
before the fill is a missed trade. Picked on the tune weeks (split.py), one run on the check weeks.

  node --env-file=.env <dir>/run.mjs fair_fill.py      (from the app repo root)
-> data/local/x/bt/fair_fill_trades.csv, fair_fill_summary.json
"""
import bisect, csv, gzip, json, math, multiprocessing as mp, os, statistics as st, sys
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
from score_sum import account
from split import half
from store import calendar, day, iv_delta

B = "data/local/x/bt"
CAL = calendar()
SZ = {}


def book_sz(date):
    """{contract: [(minute, bid, ask, bid size, ask size)]} for the source's cache (RB.DBX)."""
    k = (RB.DBX, date)
    if k not in SZ:
        if len(SZ) > 3: SZ.clear()
        by = {}
        path = os.path.join(RB.DBX, f"{date}.csv.gz")
        if os.path.exists(path):
            for r in csv.DictReader(gzip.open(path, "rt")):
                if r["bid"] and r["ask"] and float(r["bid"]) > 0 and float(r["ask"]) > 0:
                    by.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"]), float(r["bid_sz"] or 0), float(r["ask_sz"] or 0)))
        for v in by.values(): v.sort()
        SZ[k] = by
    return SZ[k]


def quote_sz(c, date, minute):
    """The book at the end of `minute` with its sizes (real_bench.quote's convention: the row labelled minute + 1)."""
    v = book_sz(date).get(c)
    if not v: return None
    i = bisect.bisect(v, (minute + 2, -1)) - 1
    if i < 0 or v[i][0] < minute - 3: return None
    return v[i][1:]


def bs(spot, k, t, iv, call, r=0.045):
    if t <= 0 or iv <= 0: return max(0.0, spot - k if call else k - spot)
    d1 = (math.log(spot / k) + (r + iv * iv / 2) * t) / (iv * math.sqrt(t)); d2 = d1 - iv * math.sqrt(t)
    N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
    if call: return spot * N(d1) - k * math.exp(-r * t) * N(d2)
    return k * math.exp(-r * t) * N(-d2) - spot * N(-d1)


def fair_chain(t, c, exp, k, minute):
    """Our strike priced with the IV of its two neighbours at the same minute, or None."""
    call = t["right"] == "C"
    bars = [b for b in day(t["sym"], t["date"]) if b[0] <= minute]
    if not bars: return None
    spot = bars[-1][4]
    T = sim.years_to_expiry(t["date"], minute, exp)
    ks = sorted(sim.chain(t["sym"], exp, t["right"]))
    if k not in ks: return None
    i = ks.index(k)
    if i == 0 or i == len(ks) - 1: return None
    pts = []
    for j in (i - 1, i + 1):
        q = quote_sz(sim.occ(t["sym"], exp, ks[j], t["right"]), t["date"], minute)
        if not q: return None
        x = iv_delta((q[0] + q[1]) / 2, spot, ks[j], T, 0.045, call)
        if not x: return None
        pts.append((ks[j], x[0]))
    iv = pts[0][1] + (pts[1][1] - pts[0][1]) * (k - pts[0][0]) / (pts[1][0] - pts[0][0])
    return bs(spot, k, T, iv, call)


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], float(t["price"]))
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    buy = real[0]
    fill_m = buy[1]
    q = quote_sz(c[0], t["date"], fill_m - 1)
    row = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], contract=c[0], d2=int(float(t.get("c_t") or 9) < 1.8),
               fill_m=fill_m, paid=rcost, steps=real, r1=sim.result(rcost, real, 0.01), r05=sim.result(rcost, real, 0.005))
    if q:
        bid, ask, bs_, as_ = q
        row.update(bid=bid, ask=ask, micro=(bid * as_ + ask * bs_) / (bs_ + as_) if bs_ + as_ > 0 else None,
                   chain=fair_chain(t, c[0], c[1], c[2], fill_m - 1))
        # the next minutes: each one's low print and the book's ask, for the limit
        bars = {b[0]: b for b in day(c[0], t["date"])}
        # each waiting minute: its lowest print (a sale at or under our bid would have hit it), the book at its end
        row["path"] = []
        for mm in range(fill_m, fill_m + 4):
            qq = quote_sz(c[0], t["date"], mm)
            row["path"].append((bars[mm][3] if mm in bars else None, qq[1] if qq else None, qq))
    if kind == "main":
        sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
        held = {}
        for mm in range(m0, 390):
            k = RB.quote(c[0], t["date"], mm)
            held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
        row["held"] = held
    return row


def tick(px): return 0.01 if px < 3 else 0.05


def usual(q):
    """The bot's price on a book (bid, ask, ...): the mid + half the way to the ask."""
    mid = (q[0] + q[1]) / 2
    return mid + (q[1] - mid) / 2


def order(r, fair_key, k, wait, miss):
    """-> (paid, steps) at this limit, or None for no trade."""
    if r.get(fair_key) is None or r.get("bid") is None: return r["paid"], r["steps"]  # no estimate: as now
    cap = usual((r["bid"], r["ask"]))
    limit = min(r[fair_key] + k * tick(r[fair_key]), cap)
    first_sale = min(s[1] for s in r["steps"] if s[2] == "sell" and s[0] == r["date"]) if any(s[2] == "sell" and s[0] == r["date"] for s in r["steps"]) else 999
    for i, (low, ask, q) in enumerate(r["path"][:wait]):  # the 4th minute is only the chase's next book
        mm = r["fill_m"] + i
        if mm >= first_sale: break
        if (low is not None and low <= limit + 1e-9) or (ask is not None and ask <= limit + 1e-9):
            paid = round(limit, 4)
            return paid, [(r["date"], mm, "buy", 1.0, paid, "entry")] + [s for s in r["steps"][1:]]
    if miss == "skip": return None
    q = r["path"][wait - 1][2]
    if not q: return r["paid"], r["steps"]
    # the chase as the fill model has it: the usual price on that book, and when the next minute's bid is already above
    # it, that minute's ask, at most +10% (opt_spread.price)
    paid = usual(q)
    nxt = r["path"][wait][2]
    if nxt and nxt[0] > paid: paid = min(nxt[1], paid * 1.1)
    paid = round(paid, 4)
    return paid, [(r["date"], r["fill_m"] + wait - 1, "buy", 1.0, paid, "entry")] + [s for s in r["steps"][1:]]


def entries(R, src, part, setting):
    """The champion's trades (main + pyramid adds) under a buy setting -> (date, units, ret at 1%, saved, filled)."""
    main = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part]
    adds = {}
    for r in R:
        if r["src"] == src and r["kind"] == "add": adds.setdefault((r["date"], r["sym"], r["right"]), []).append(r)
    E = []

    def leg(r, units):
        if setting is None: return (r["date"], units, r["r1"] if units == 1 else r["r05"], 0.0, 1, r)
        o = order(r, *setting)
        if o is None: return (r["date"], units, None, 0.0, 0, r)
        paid, steps = o
        ret = sim.result(paid, steps, 0.01 * units)
        return (r["date"], units, ret, 1 - paid / r["paid"], 1, r)
    for r in main:
        E.append(leg(r, 1.0))
        if not r["d2"]: continue
        for a in sorted(adds.get((r["date"], r["sym"], r["right"]), []), key=lambda x: x["minute"]):
            if a["minute"] <= r["minute"]: continue
            share, up = r["held"].get(a["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append(leg(a, 0.5))
            break
    return E


def acct(E):
    rows = sorted((e for e in E if e[2] is not None), key=lambda e: (e[0], e[5]["minute"]))
    pnl = [dict(date=e[0], pnl=str(1e4 * e[1] * max(-1, e[2]))) for e in rows]
    a, dd = account(pnl)
    top = set(sorted(range(len(rows)), key=lambda i: -rows[i][1] * rows[i][2])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top])
    return round(a), round(dd, 3), round(a5), len(rows)


def main():
    S = {"fair": (fe.fair_signals("sg_c12_15"), fe.fair_signals("s_t18r15")), "fav": (FR.signals("25"), FR.signals("24"))}
    jobs = [(src, kind, t) for src, (m, a) in S.items() for kind, T in (("main", m), ("add", a)) for t in T]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    out = {}
    # step 1: where fair sits
    print("\n### Step 1: fair against the mid at the champion's buys (tune weeks), in half-spreads (+ = above the mid)\n")
    print("| List | Estimate | Buys with it | Median | Share below the mid | Median on winners | Median on losers | Spread median |\n|---|---|---|---|---|---|---|---|")
    for src in ("fair", "fav"):
        for key in ("micro", "chain"):
            X = [r for r in R if r["src"] == src and half(r["date"]) == "tune" and r.get(key) is not None and r["ask"] > r["bid"]]
            z = [((r[key] - (r["bid"] + r["ask"]) / 2) / ((r["ask"] - r["bid"]) / 2), r["r1"] > 0) for r in X]
            sp = st.median((r["ask"] - r["bid"]) / ((r["ask"] + r["bid"]) / 2) for r in X)
            w, l = [a for a, b in z if b], [a for a, b in z if not b]
            out[f"step1|{src}|{key}"] = dict(n=len(z), median=st.median(a for a, _ in z), below=sum(a < 0 for a, _ in z) / len(z), win=st.median(w), loss=st.median(l), spread=sp)
            print(f"| {src} | {key} | {len(z)} | {st.median(a for a, _ in z):+.2f} | {sum(a < 0 for a, _ in z) / len(z):.0%} | {st.median(w):+.2f} | {st.median(l):+.2f} | {sp:.0%} |", flush=True)
    # step 2: the grid on the tune weeks
    grid = [(f, k, w, miss) for f in ("micro", "chain") for k in (0, 1, 2, 3) for w in (1, 2, 3) for miss in ("skip", "chase")]
    print("\n### Step 2: the limit order on the tune weeks, 1% from $100,000 (now = the mid + half to the ask)\n")
    print("| Fair | Ticks | Wait | Not filled | Fair list | Favorites 24m | Filled | Saved a filled buy | Without the best 5 (fair / fav) |\n|---|---|---|---|---|---|---|---|---|")
    base = {src: acct(entries(R, src, "tune", None)) for src in ("fair", "fav")}
    print(f"| now | | | | ${base['fair'][0]:,} / {base['fair'][1]:.0%} | ${base['fav'][0]:,} / {base['fav'][1]:.0%} | 100% | 0% | ${base['fair'][2]:,} / ${base['fav'][2]:,} |")
    scores = []
    for g in grid:
        res = {}
        for src in ("fair", "fav"):
            E = entries(R, src, "tune", g)
            res[src] = acct(E)
            res[src + "_fill"] = sum(e[4] for e in E) / len(E)
            sv = [e[3] for e in E if e[4]]
            res[src + "_saved"] = st.mean(sv) if sv else 0
        out["tune|" + "|".join(map(str, g))] = res
        scores.append((min(res["fair"][0] / base["fair"][0], res["fav"][0] / base["fav"][0]), g))
        print(f"| {g[0]} | {g[1]} | {g[2]} min | {g[3]} | ${res['fair'][0]:,} / {res['fair'][1]:.0%} | ${res['fav'][0]:,} / {res['fav'][1]:.0%} | "
              f"{(res['fair_fill'] + res['fav_fill']) / 2:.0%} | {(res['fair_saved'] + res['fav_saved']) / 2:.1%} | ${res['fair'][2]:,} / ${res['fav'][2]:,} |", flush=True)
    best = max(scores)[1]
    print(f"\nPicked on tune (the best of the worse of the two lists against now): {best}\n")
    print("### The check weeks, one run\n\n| Buy | Fair list | Favorites 24m | Without the best 5 (fair / fav) |\n|---|---|---|---|")
    for name, g in (("now", None), (" / ".join(map(str, best)), best)):
        c = {src: acct(entries(R, src, "check", g)) for src in ("fair", "fav")}
        out["check|" + name] = c
        print(f"| {name} | ${c['fair'][0]:,} / {c['fair'][1]:.0%} | ${c['fav'][0]:,} / {c['fav'][1]:.0%} | ${c['fair'][2]:,} / ${c['fav'][2]:,} |", flush=True)
    out["best"] = best
    json.dump(out, open(f"{B}/fair_fill_summary.json", "w"), indent=1, default=str)
    with open(f"{B}/fair_fill_trades.csv", "w") as f:
        keys = ["src", "kind", "date", "minute", "sym", "right", "contract", "d2", "fill_m", "paid", "r1", "bid", "ask", "micro", "chain"]
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore"); w.writeheader(); w.writerows(R)


if __name__ == "__main__":
    main()
