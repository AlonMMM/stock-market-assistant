"""Second-level entries on the champion (the user, 2026-10-27: "Timing with 1-second stock moves": enter within the
minute, don't buy the spike; and "you don't need to wait 1 minute - you can wait 5 seconds ... go up to the next price
every 5 seconds and limit on the usual start"). Data: sec_fetch_main.py (the stock's 1-second bars for the entry day,
the option's 1-second book from 2 minutes before the signal to 10 after). The champion's legs (2.5 + IBIT $0.10 + the
pyramid), real quotes; only the buy changes, the sales stay as walked. The bot acts LAG = 2 seconds after a decision.
Set before running:
  now        the buy as the benchmark has it: the usual price (mid + half to the ask) on the book as the signal minute ends
  now-1s     the same on the 1-second book at the decision second (to tie the minute model to the second data)
  min-strict fair_fill's winner (microprice + 3 ticks, 1 minute, then the usual price) with only the ask as fill proof
  ladderS_K  a limit at the microprice + K ticks (K 0 / 1), one tick more every S seconds (5 / 10), never above the usual
             price at the decision; filled when the ask is at or under it at a second; after 60 seconds the usual price
             then (with the runaway rule: the ask 10 seconds on, at most +10%, when that bid is above it)
  early      the first second inside the signal minute the rule already holds (t and D2 with the minute so far; SPY's
             move inside that minute spread evenly: no SPY seconds), the usual price on that second's book
  spikeX     at the decision, if the stock moved X x S30 (0.15 / 0.25) our way in the last 15 seconds, wait up to 60
             seconds for a pullback of a third of that burst, then the usual price; no pullback: the usual price at 60 s
A buy with no 1-second book keeps its benchmark price (counted). Tune / check by entry week, fair list and Favorites.

  node --env-file=.env <dir>/run.mjs sec_timing.py      (from the app repo root)
-> data/local/x/bt/sec_timing_summary.json
"""
import bisect, collections, csv, gzip, json, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import fair_fill as FF
import fav_real as FR
import floor_exception as fe
from levels import ctx
from score_sum import account
from signals import series, beta
from split import half
from store import calendar, day

B = "data/local/x/bt"
SEC = os.path.join(HERE, "sec_cache", "main")
CAL = calendar()
LAG = 2
VARIANTS = ("now", "now-1s", "min-strict", "ladder5_0", "ladder5_1", "ladder10_0", "early", "spike15", "spike25",
            "now-1s-r60", "early-r60", "min-strict-r60", "early5-r60", "early10-r60", "early5nv-r60")
# the runaway rule's look-ahead: 10 seconds (above) or 60, as the minute model has it (the bid a minute on above our price:
# not filled, the ask then); the r60 variants tie the second data to the minute model


def load_book(date, c, m):
    p = os.path.join(SEC, "opt", f"{date}_{c}_{m}.csv.gz")
    if not os.path.exists(p): return None
    rows = [(int(r[0]), float(r[1]), float(r[2]), float(r[3] or 0), float(r[4] or 0)) for r in csv.reader(gzip.open(p, "rt")) if r and r[1] and r[2]]
    return rows or None


def load_stock(date, sym):
    p = os.path.join(SEC, "stock", f"{date}_{sym}.csv.gz")
    if not os.path.exists(p): return None
    return [(int(r[0]), float(r[4]), float(r[5])) for r in csv.reader(gzip.open(p, "rt")) if r]


def at(rows, s):
    """The last row at or before second s (a book or a price as that second ended)."""
    i = bisect.bisect(rows, (s, 1e18)) - 1
    return rows[i] if i >= 0 else None


def usual(bid, ask):
    mid = (bid + ask) / 2
    return mid + (ask - mid) / 2


def runaway(book, s, p, look=10):
    nxt = at(book, s + look)
    if nxt and nxt[1] > p: return min(nxt[2], p * 1.1)
    return p


def ladder(book, D, step, k, wait=60):
    b = at(book, D)
    if not b or b[1] <= 0 or b[2] <= b[1] * 0.5: return None
    bid, ask, bs_, as_ = b[1:]
    micro = (bid * as_ + ask * bs_) / (bs_ + as_) if bs_ + as_ > 0 else (bid + ask) / 2
    cap, tk = usual(bid, ask), FF.tick(micro)
    for s in range(D, D + wait + 1):
        limit = min(micro + (k + (s - D) // step) * tk, cap)
        q = at(book, s)
        if q and q[2] <= limit + 1e-9: return s, round(limit, 4)
    q = at(book, D + wait)
    if not q: return None
    return D + wait, round(runaway(book, D + wait, usual(q[1], q[2])), 4)


def plain(book, s, look=10):
    q = at(book, s)
    if not q: return None
    return s, round(runaway(book, s, usual(q[1], q[2]), look), 4)


def spike(book, stock, D, unit, side, x):
    p_now, p_back = at(stock, D), at(stock, D - 15)
    if not (p_now and p_back): return plain(book, D)
    burst = side * (p_now[1] / p_back[1] - 1) / unit
    if burst < x: return plain(book, D)
    target = p_now[1] - side * (p_now[1] - p_back[1]) / 3
    for s in range(D + 1, D + 61):
        q = at(stock, s)
        if q and side * (q[1] - target) <= 0: return plain(book, s + LAG)
    return plain(book, D + 60)


def early_second(t, stock, every=1, novol=False):
    """The first second inside the signal minute where the rule holds with the minute so far, or None."""
    sym, date, m0 = t["sym"], t["date"], int(t["minute"])
    i = CAL.index(date)
    bars, sbars = day(sym, date), day("SPY", date)
    b_ = beta(sym, date, i, CAL)
    cx = ctx(sym, date)
    if b_ is None or not cx or not cx["sd"] or m0 < 2: return None
    unit = cx["sd"]
    c, spy = series(bars)[0], series(sbars)[0]
    vol = [0] * 390
    for x in bars: vol[x[0]] = x[5]
    hist = []
    for d in CAL[i - 20:i]:
        v = [0] * 390
        for x in day(sym, d): v[x[0]] = x[5]
        hist.append(sum(v[:m0 + 1]))
    hist = sorted(h for h in hist if h > 0)
    if len(hist) < 10 or not (c[m0 - 1] and spy[m0] and spy[m0 - 1]): return None
    usual_v = hist[len(hist) // 2]
    side = 1 if t["right"] == "C" else -1
    n = s1 = s2 = 0.0
    ex = []
    for m in range(1, m0):
        if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            rs, rp = c[m] / c[m - 1] - 1, spy[m] / spy[m - 1] - 1
            x = rs - b_ * rp
            n += 1; s1 += x; s2 += x * x
            ex.append((m, rp, x))
    d2 = sum(side * x / unit for m, rp, x in ex if m > m0 - 30 and side * rp < 0)   # the 30-minute window before this minute
    cum_before = sum(vol[:m0])
    rp_full = spy[m0] / spy[m0 - 1] - 1
    for s in range(60 * m0 + every - 1, 60 * m0 + 60, every):   # every: the live bot looks every 10 s, not every second
        q = at(stock, s)
        if not q or q[0] < 60 * m0 - 5: continue
        frac = (s - 60 * m0 + 1) / 60
        rs = q[1] / c[m0 - 1] - 1
        rp = rp_full * frac
        x = rs - b_ * rp
        nn, ss1, ss2 = n + 1, s1 + x, s2 + x * x
        mu = ss1 / nn; var = max(ss2 / nn - mu * mu, 0.0)
        tt = side * (mu / math.sqrt(var) * math.sqrt(nn) if var > 0 else 0.0)
        vsec = 0 if novol else sum(v for sec, _, v in stock if 60 * m0 <= sec <= s)   # novol: the live bot sees no volume of the forming minute
        rv = (cum_before + vsec) / usual_v if usual_v else 0
        dd = d2 + (side * x / unit if side * rp < 0 else 0)
        if rv >= 1.5 and (tt >= 1.8 or (tt >= 1.2 and dd >= 1.5)): return s
    return None


def one(job):
    src, kind, t = job
    r = FF.one((src, kind, t))
    if not r: return None
    m0 = int(t["minute"])
    book = load_book(t["date"], r["contract"], m0)
    stock = load_stock(t["date"], t["sym"])
    D = 60 * m0 + 59 + LAG
    res = {"now": (None, r["paid"])}
    if book:
        res["now-1s"] = plain(book, D)
        res["now-1s-r60"] = plain(book, D, 60)
        b = at(book, 60 * m0 + 59)
        if b and b[3] + b[4] > 0:
            micro = (b[1] * b[4] + b[2] * b[3]) / (b[3] + b[4])
            limit = min(micro + 3 * FF.tick(micro), usual(b[1], b[2]))
            hit = next((s for s in range(D, D + 61) if (at(book, s) or (0, 0, 1e9))[2] <= limit + 1e-9), None)
            res["min-strict"] = (hit, round(limit, 4)) if hit is not None else plain(book, D + 60)
            res["min-strict-r60"] = (hit, round(limit, 4)) if hit is not None else plain(book, D + 60, 60)
        res["ladder5_0"], res["ladder5_1"], res["ladder10_0"] = ladder(book, D, 5, 0), ladder(book, D, 5, 1), ladder(book, D, 10, 0)
        if stock:
            cx = ctx(t["sym"], t["date"])
            side = 1 if t["right"] == "C" else -1
            if cx and cx["sd"]:
                res["spike15"], res["spike25"] = spike(book, stock, D, cx["sd"], side, 0.15), spike(book, stock, D, cx["sd"], side, 0.25)
            if kind == "main":
                try: es = early_second(t, stock)
                except Exception: es = None
                res["early"] = plain(book, es + LAG) if es is not None else res["now-1s"]
                res["early-r60"] = plain(book, es + LAG, 60) if es is not None else res["now-1s-r60"]
                for every in (5, 10):
                    try: ev = early_second(t, stock, every)
                    except Exception: ev = None
                    res[f"early{every}-r60"] = plain(book, ev + LAG, 60) if ev is not None else res["now-1s-r60"]
                try: ev = early_second(t, stock, 5, novol=True)
                except Exception: ev = None
                res["early5nv-r60"] = plain(book, ev + LAG, 60) if ev is not None else res["now-1s-r60"]
    r.pop("path", None)
    r["buys"] = {k: v for k, v in res.items() if v}
    r["has_book"] = int(bool(book))
    return r


def leg(r, v, units):
    """-> the leg's return per unit at this size under variant v."""
    got = r["buys"].get(v)
    if not got or v == "now": return sim.result(r["paid"], r["steps"], 0.01 * units)
    s, paid = got
    first_sale = min((x[1] for x in r["steps"] if x[2] == "sell" and x[0] == r["date"]), default=999)
    m = (s // 60) if s is not None else r["fill_m"]
    if m >= first_sale: return sim.result(r["paid"], r["steps"], 0.01 * units)
    steps = [(r["date"], m, "buy", 1.0, paid, "entry")] + r["steps"][1:]
    return sim.result(paid, steps, 0.01 * units)


def entries(R, adds, v, src, part, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        E.append((r["date"], r["minute"], 1.0, leg(r, v, 1.0)))
        if not r["d2"]: continue
        for x in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if x["minute"] <= r["minute"]: continue
            share, up = r["held"].get(x["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((x["date"], x["minute"], 0.5, leg(x, v, 0.5)))
            break
    return E


def stats(E):
    R = sorted(E)
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[3]))) for e in R]
    acct, dd = account(pnl)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top])
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    main_ = [r for r in R if r["kind"] == "main"]
    print(f"legs with a 1-second book: {sum(r['has_book'] for r in R)} of {len(R)}; main entries where 'early' fired before the minute's end: "
          f"{sum(1 for r in main_ if r['buys'].get('early') and r['buys'].get('now-1s') and r['buys']['early'][0] < r['buys']['now-1s'][0])}", flush=True)
    out = {}
    print("\n### Tune weeks, real quotes, 1% from $100,000\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) |\n|---|---|---|---|")
    for v in VARIANTS:
        f, g = stats(entries(R, adds, v, "fair", "tune")), stats(entries(R, adds, v, "fav", "tune", FR.A24))
        out[f"tune|{v}"] = dict(fair=f, fav=g)
        print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} |", flush=True)
    base = out["tune|now"]
    score = lambda v: min(out[f"tune|{v}"]["fair"]["acct"] / base["fair"]["acct"], out[f"tune|{v}"]["fav"]["acct"] / base["fav"]["acct"])
    pick = [v for v in VARIANTS if v not in ("now", "now-1s", "now-1s-r60")]
    best = max(pick, key=score)
    print(f"\nPicked on tune: {best}; better than now on both tune lists: {score(best) > 1}\n")
    print("### Check weeks, one run\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) |\n|---|---|---|---|")
    for v in ("now-1s-r60", "early-r60", "early5-r60", "early10-r60", "early5nv-r60"):
        f, g = stats(entries(R, adds, v, "fair", "check")), stats(entries(R, adds, v, "fav", "check", FR.A24))
        out[f"check|{v}"] = dict(fair=f, fav=g)
        print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} |", flush=True)
    out["best"] = best
    json.dump(out, open(f"{B}/sec_timing_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
