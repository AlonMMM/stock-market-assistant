"""Sell above the bid (the user, 2026-11-04: "We are not optimized the selling and always sell at the bid in the main
bot.. Cant we do better exit?"; then "In real market we have market maker. And we can exit even in the mid price. Wdyt
about black sholts calculation, than try to exit on it, plus 30% more between in and the bid ... Option price calc as
1.0, Bid is 0.6, Exit on 0.87 or somthing"). Built on 2.10 (size_volume.py t3A-c5: its entries, picks, exits, sizing and
pyramid; the exits decided on the real price paid). Only the sale price changes, so the trades are 2.10's one for one.

A limit is posted at the end of the decision minute (the book the bot sees, real_bench.quote). It counts as FILLED only
when the option really trades at or above it in a following minute (the option's minute bar high, store.day) or the
bid comes up to it; else, at the end of its window, the sale takes the bid then. Never above the ask minus a cent; a
limit at or under the bid is the bid. Set before running:
  bid-c5      2.10 as is: the bid at once
  mid1-c5     the mid for 1 minute, then the bid (the 2026-10-26 idea, opt_spread "mid", with the stricter fill proof)
  bs30-c5     the user's: BS - 30% of (BS - bid) for 1 minute, then the bid. BS = Black-Scholes at the stock's price
              that minute and the time left, with the IV of the entry book's mid (what the bot knows; no look-ahead)
  bs30s-c5    the user's price stepped down: minute 1 the price, minute 2 two thirds of the way above the bid, minute 3
              one third, then the bid (minute bars cannot show seconds, so a step a minute)
  bs30sp-c5   bs30s on the planned exits only (end of day, a gap our way); the adverse exits (stock stages, t, the
              option stop, the break-even lock, a gap against) sell at the bid at once
Second run (the user, 2026-11-04: "you can move up to 5 minutes try to sold it. find the best."), N = 1..5 minutes:
  S<N>-c5     from BS - 30%, stepped down evenly over N minutes (minute k at the bid + (1 - k/N) of the gap), then the
              bid (S1 = bs30, S3 = bs30s)
  F<N>-c5     BS - 30% held flat for N minutes, then the bid
  M<N>-c5     from the mid, stepped down the same way over N minutes, then the bid
One pick over all 15 on tune; only it runs on check (look 2).
Tune = even weeks, check = odd (split.py), the same run; one pick on tune by min(fair, Favorites) vs 2.10 at 2%; only
the pick is priced on check. Fill proof caveat: a print at our price does not prove our order was first in line, and
a market maker can fill a resting order with no earlier print, so this can err both ways.

  node --env-file=.env <dir>/run.mjs sale_limit.py      (from the app repo root)
-> data/local/x/bt/sale_limit_summary.json, sale_limit_sales.csv (every 2.10 sale under every variant)
"""
import collections, csv, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import size_volume as SV   # sets 2.9's exits (BT_X); 2.10 = its t3A-c5 sizing
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
from store import bs, day, iv_delta

B = "data/local/x/bt"
MODES = ("bid-c5",) + tuple(f"{k}{n}-c5" for k in "SFM" for n in range(1, 6))
ADVERSE = {"T_half", "T_full", "T_tstat", "U_out", "U_rest", "U_check10", "U_check20", "BE_lock", "morning_gap_against",
           "F_break"}
for v in MODES: SV.SIZEV[v] = SV.SIZEV["t3A-c5"]


OUT = os.environ.get("SL_OUT", "")   # a suffix for the output files
TICK = os.environ.get("SL_TICK") == "1"
BUSY = os.environ.get("SL_BUSY") == "1"   # the live 2.11: a sale decided while another walks waits for it to end   # the release check (2026-11-06): levels on the option's tick, as live 2.11
if os.environ.get("SL_MODES"): MODES = tuple(os.environ["SL_MODES"].split(","))


def tick_down(x):
    t = 0.01 if x < 3 else 0.05
    return round(math.floor(x / t + 1e-9) * t, 2)


def bar(sym, d, m):
    for b in day(sym, d):
        if b[0] == m: return b
    return None


def fair(c, und, right, d, m, iv0):
    """Black-Scholes at the stock's close of minute m with the entry IV, or None."""
    sb = bar(und, d, m)
    if not sb or iv0 is None: return None
    T = sim.years_to_expiry(d, m, c[1])
    return bs(sb[4], c[2], T, iv0, cu.C["rate"], right == "C")[0]


def sell(mode, c, und, right, d, m, rule, iv0):
    """One sale under a mode -> (price, info dict). The book at the end of minute m - 1 is the decision's."""
    at = max(m - 1, 0)
    k = RB.quote(c[0], d, at)
    if not k: return None
    bid, ask = k
    mid = (bid + ask) / 2
    info = dict(bid=bid, ask=ask, mid=round(mid, 4), bs=None, limit=None, filled_min=None)
    if mode == "bid-c5": return bid, info
    kind, n = mode[0], int(mode[1:-3])
    if TICK and m + n >= 390: return bid, info   # the live 2.11: no walk that cannot end before the close
    if kind == "M":
        top = mid
    else:
        f = fair(c, und, right, d, at, iv0)
        info["bs"] = None if f is None else round(f, 4)
        if f is None: return bid, info
        top = f - 0.3 * (f - bid)
    steps = [top] * n if kind == "F" else [bid + (top - bid) * (1 - k / n) for k in range(n)]
    cap = ask - 0.01
    if TICK: steps = [tick_down(min(x, cap)) for x in steps]   # the live 2.11: the option's tick ($0.05 from $3), down
    else: steps = [math.floor(min(x, cap) * 100 + 1e-6) / 100 for x in steps]   # a sale limit in whole cents, rounded down
    info["limit"] = round(steps[0], 4)
    if steps[0] <= bid: return bid, info
    for i, L in enumerate(steps):
        j = m + i
        if j > 389: break
        if L <= bid: return bid, info
        b = bar(c[0], d, j)
        q = RB.quote(c[0], d, j)
        if (b and b[2] >= L - 1e-9) or (q and q[0] >= L - 1e-9):
            info["filled_min"] = i + 1
            return round(L, 4), info
    q = RB.quote(c[0], d, min(m + len(steps) - 1, 389))
    return (q[0] if q else bid), info


def price(steps, c, cost, mode, und, right, iv0, log):
    """opt_spread.price "bid" with the sales under a mode; each sale's record into log."""
    rcost, real = OS.price(steps, c[0], cost, "bid")
    if mode == "bid-c5" and log is None: return rcost, real
    out, busy = [], {}
    for s, r in zip(steps, real):
        d, m, side, q, px, rule = r
        if side != "sell" or rule.endswith("_1s"): out.append(r); continue
        at = m
        if BUSY and mode != "bid-c5" and busy.get(d, -1) > m: at = busy[d]   # the live bot: no new sale while one walks
        got = sell(mode, c, und, right, d, at, rule, iv0)
        if got is None: out.append(r); continue
        p, info = got
        if BUSY and mode != "bid-c5":
            n = int(mode[1:-3])
            busy[d] = at + (info["filled_min"] or (n if info["limit"] and info["limit"] > info["bid"] else 0))
        out.append((d, m, side, q, round(p, 4), rule))
        if log is not None: log.append(dict(mode=mode, day=d, minute=m, rule=rule, share=q, got=round(p, 4), **info))
    return rcost, out


def walk_modes(t, m, px):
    """2.10's pick and walk (size_volume.walk_at), priced under every mode -> ({mode: row}, sales) or None."""
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], px)
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, _ = OS.price(steps, c[0], cost, "bid")
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL, paid=rcost)
    if cost is None: return None
    rcost, base = OS.price(steps, c[0], cost, "bid")
    # the entry IV: the entry book's mid at the stock's price then, else the pick's
    iv0 = c[6]
    k, sb = RB.quote(c[0], t["date"], max(m - 1, 0)), bar(t["sym"], t["date"], m)
    if k and sb:
        x = iv_delta((k[0] + k[1]) / 2, sb[4], c[2], sim.years_to_expiry(t["date"], m, c[1]), cu.C["rate"], t["right"] == "C")
        if x: iv0 = x[0]
    sells = [s for s in base if s[2] == "sell" and s[0] == t["date"]]
    held = {}
    for mm in range(m, 390):
        q = RB.quote(c[0], t["date"], mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not q else (q[0] + q[1]) / 2 / rcost - 1)
    rows, log = {}, []
    for mode in MODES:
        _, real = price(steps, c, cost, mode, t["sym"], t["right"], iv0, log)
        rows[mode] = dict(r1=sim.result(rcost, real, 0.01), r2=sim.result(rcost, real, 0.02), r3=sim.result(rcost, real, 0.03),
                          r15=sim.result(rcost, real, 0.015), r05=sim.result(rcost, real, 0.005),
                          over=int(any(s[2] == "carry" for s in steps)), h=booked(rcost, real), held=held)
    for x in log: x.update(contract=c[0], paid=round(rcost, 4), iv0=round(iv0, 4) if iv0 else None)
    return rows, log


CAL = SV.CAL


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    got = walk_modes(t, m0, float(t["price"]))
    if got is None: return None
    rows, log = got
    for x in log: x.update(src=src, kind=kind, sym=t["sym"], right=t["right"], entry_day=t["date"], entry_min=m0,
                           part=half(t["date"]), rvol=float(t.get("c_rvol") or 0))
    return dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"],
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0),
                v=rows, at={v: m0 for v in rows}, log=log)


def table(R, adds, part, modes, out, title):
    for size in (0.02, 0.03):
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | vs 2.10 | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in modes:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(SV.entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                b = out.get(f"{part}|bid-c5|{src}|{size}", s)["acct"]
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | {s['acct'] / b:.3f} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)


def fills(L, part, modes, out):
    """Per mode: the sales, the share filled above the bid, the average gain over the bid, adverse vs planned."""
    print(f"\n#### Fills, {part} weeks (every 2.10 sale with a book; main legs and adds)\n")
    print("| Version | List | Exits | Sales | Limit above the bid | Filled at the limit | Avg vs the bid (all sales) | Avg vs the bid when filled | Unfilled: bid then vs bid at once |")
    print("|---|---|---|---|---|---|---|---|---|")
    for v in modes[1:]:
        for src in ("fair", "fav"):
            for kind, test in (("adverse", lambda r: r in ADVERSE), ("planned", lambda r: r not in ADVERSE)):
                xs = [x for x in L if x["mode"] == v and x["src"] == src and x["part"] == part and test(x["rule"])]
                if not xs: continue
                rel = [x["got"] / x["bid"] - 1 for x in xs if x["bid"] > 0]
                above = [x for x in xs if x["limit"] is not None and x["limit"] > x["bid"]]
                hit = [x for x in above if x["filled_min"]]
                miss = [x["got"] / x["bid"] - 1 for x in above if not x["filled_min"] and x["bid"] > 0]
                g = [x["got"] / x["bid"] - 1 for x in hit if x["bid"] > 0]
                key = f"fills|{part}|{v}|{src}|{kind}"
                out[key] = dict(n=len(xs), above=len(above), hit=len(hit), avg=st.mean(rel) if rel else 0,
                                avg_hit=st.mean(g) if g else 0, miss=st.mean(miss) if miss else 0)
                print(f"| {v} | {src} | {kind} | {len(xs)} | {len(above)} | {len(hit)} ({len(hit) / max(1, len(above)):.0%}) | {out[key]['avg']:+.1%} | {out[key]['avg_hit']:+.1%} | {out[key]['miss']:+.1%} |", flush=True)
    bsx = [x for x in L if x["mode"] == "S1-c5" and x["part"] == part and x["bs"] and x["ask"] > x["bid"]]
    if bsx:
        pos = [(x["bs"] - x["mid"]) / ((x["ask"] - x["bid"]) / 2) for x in bsx]
        print(f"\nWhere BS sat ({part}): median {st.median(pos):+.2f} half-spreads from the mid; above the ask {sum(p > 1 for p in pos) / len(pos):.0%}, under the bid {sum(p < -1 for p in pos) / len(pos):.0%}", flush=True)
        out[f"bspos|{part}"] = dict(median=st.median(pos), above_ask=sum(p > 1 for p in pos) / len(pos), under_bid=sum(p < -1 for p in pos) / len(pos))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    L = [x for r in R for x in r["log"]]
    with open(f"{B}/sale_limit{OUT}_sales.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(L[0].keys())); w.writeheader(); w.writerows(L)
    out = {}
    table(R, adds, "tune", MODES, out, "Tune weeks (even)")
    score = lambda v: min(out[f"tune|{v}|{s}|0.02"]["acct"] / out[f"tune|bid-c5|{s}|0.02"]["acct"] for s in ("fair", "fav"))
    best = max(MODES[1:], key=score)
    out["best"] = best
    fills(L, "tune", tuple(dict.fromkeys(("bid-c5", "S3-c5", best))), out)
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs 2.10, 2%): {best} ({score(best):.3f}); better on both: {score(best) > 1}", flush=True)
    table(R, adds, "check", ("bid-c5", best), out, "Check weeks (odd), the same run")
    fills(L, "check", ("bid-c5", best), out)
    json.dump(out, open(f"{B}/sale_limit{OUT}_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
