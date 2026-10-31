"""Spread rules, sale prices and a lower volume floor on real quotes (the user, 2026-10-26: "1. when spread is more than
15% - go one delta down and one delta up to see if the spread is better. if yes - buy - if not try again on 20%-30% and
blocks if it's more than 30%. play with the numbers here 2. try to add a stop limit and selling not in bid 3. you can
try on 50 or 100 contract as long as they are fit with rule number 1." Tuned on 2024-2025; 2026 is the held-out check).

Built on 2.6 (live: c12_15 entries, the CHAMP exits, the cheap fallback), the fair list, priced on the real best bid/ask
(Databento OPRA cbbo-1m, as real_bench.py): a buy pays the mid + half the way to the ask (or the next minute's ask, at
most +10%, when it ran away). Spread = (ask - bid) / mid at the signal minute.

Contract (set before running):
  base          2.6's pick (0.15 delta; under $0.20 the cheap fallback), 200+ contracts in 30 minutes, no spread rule
  look a, cap c only for a pick the bot would buy (the floor, $0.20+): the pick if its spread <= a; else of the pick and the next strike in and out (each $0.20+, the floor, a
                quote) the narrowest, if <= c; else no trade. (A middle level, "20% then 30%", picks the same strike as
                the cap alone: the narrowest under 20% is the narrowest under 30% - so two numbers.)
                look 15 cap 30 (the user's), look 10 / 20 / 30 cap 30, look 15 cap 20 / 40, and block30 (only the
                pick, none over 30%)
  floor         200 (now), 100, 50 contracts in 30 minutes: 100 and 50 only with a spread rule (the user's rule 3)
Sale (set before running):
  bid           every sale at the bid (the bot now)
  half          a limit halfway from the mid to the bid; filled unless the ask a minute later is already below it (it fell
                away), then that minute's bid (as leg_realspread.py's "better sale")
  mid           a limit at the mid, the same fallback
  half-nostop   "half" for the other sales; the stops (10/20-minute checks, -30%, rest stop, strength exit) at the bid
$0.62 a contract each way and the 10% overnight cap at each size.

  node --env-file=.env <dir>/run.mjs opt_spread.py      (from the app repo root)
-> data/local/x/bt/opt_spread_trades.csv, opt_spread_summary.json
"""
import csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import news_filter as nf
import real_bench as RB
from d2_failed_break import CHAMP
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = RB.CAL
C = sim.C
LAST = RB.LAST
STOPS = {"U_out", "U_rest", "U_check10", "U_check20", "T_tstat"}
RULES = {"base": None, "look15 cap30": (0.15, 0.30), "look10 cap30": (0.10, 0.30), "look20 cap30": (0.20, 0.30),
         "look30 cap30": (0.30, 0.30), "look15 cap20": (0.15, 0.20), "look15 cap40": (0.15, 0.40), "block30": "block30"}
FLOORS = (200, 100, 50)
SALES = ("bid", "half", "mid", "half-nostop")


def spread(c, date, m):
    k = RB.quote(c[0], date, m)
    if not k: return None
    bid, ask = k
    return (ask - bid) / ((ask + bid) / 2)


def base_pick(cands):
    """2.6's choice without the floor: the delta nearest 0.15; under $0.20 the cheapest at $0.20+ toward the money."""
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - C["delta"]))
    if best[4] < C["min_price"]:
        ok = [c for c in cands if c[4] >= C["min_price"] and abs(c[3]) >= abs(best[3])]
        if not ok: return None
        best = min(ok, key=lambda c: c[4])
    return best


def choose(cands, date, m, rule, floor):
    """-> the contract (symbol, expiry) or None."""
    best = base_pick(cands)
    if not best: return None
    fits = lambda c: c[4] >= C["min_price"] and c[5] >= floor
    if rule is None: return (best[0], best[1]) if fits(best) else None
    sp = spread(best, date, m)
    if rule == "block30": return (best[0], best[1]) if fits(best) and sp is not None and sp <= 0.30 else None
    by_strike = sorted(cands, key=lambda c: c[2])
    i = by_strike.index(best)
    trio = [best] + [by_strike[j] for j in (i - 1, i + 1) if 0 <= j < len(by_strike)]
    look, cap = rule
    # The neighbours replace a pick the bot would buy whose spread is wide, not a pick too thin or too cheap to buy (that
    # would be a liquidity fallback, tested before: it loses)
    if not fits(best): return None
    if sp is not None and sp <= look: return best[0], best[1]
    priced = [(spread(c, date, m), n, c) for n, c in enumerate(trio) if fits(c)]
    ok = [x for x in priced if x[0] is not None and x[0] <= cap]
    if not ok: return None
    narrowest = min(ok)[2]
    return narrowest[0], narrowest[1]


def price(steps, c, cost, sale):
    """The real fills of a walk; -> (real cost, steps)."""
    real, rcost = [], cost
    for d, m, side, q, px, rule in steps:
        if side not in ("buy", "sell"): real.append((d, m, side, q, px, rule)); continue
        at = max(m - 1, 0)
        k = RB.quote(c, d, at)
        if not k: real.append((d, m, side, q, px, rule)); continue
        bid, ask = k; mid = (bid + ask) / 2
        if side == "buy":
            p = mid + (ask - mid) / 2
            later = RB.quote(c, d, at + 1)
            if later and later[0] > p:   # BT_CHASE=ask (the audit 2026-10-31): the live bot chases the ask, no +10% cap
                p = later[1] if os.environ.get("BT_CHASE") == "ask" else min(later[1], p * 1.1)
            if rule != "rebuy": rcost = p
        else:
            limit = None
            if sale == "half" or (sale == "half-nostop" and rule not in STOPS): limit = mid - (mid - bid) / 2
            if sale == "mid": limit = mid
            p = bid
            if limit is not None:
                later = RB.quote(c, d, at + 1)
                p = limit
                if later and later[1] < limit: p = later[0]
        real.append((d, m, side, q, round(p, 4), rule))
    return rcost, real


def one(t):
    m, date = int(t["minute"]), t["date"]
    cands = cu.candidates(t["sym"], date, m, t["right"], float(t["price"]))
    picks = {}
    for rule, lv in RULES.items():
        for floor in FLOORS:
            if rule == "base" and floor != 200: continue
            picks[(rule, floor)] = choose(cands, date, m, lv, floor)
    walks = {}
    out = []
    sim.X.clear(); sim.X.update(CHAMP)
    for (rule, floor), p in picks.items():
        if not p: continue
        if p not in walks: walks[p] = sim.walk(t["sym"], date, m, t["right"], p[0], p[1], CAL)
        cost, steps, _ = walks[p]
        if cost is None: continue
        for sale in SALES:
            rcost, real = price(steps, p[0], cost, sale)
            out.append(dict(rule=rule, floor=floor, sale=sale, date=date, sym=t["sym"], right=t["right"], minute=m, contract=p[0],
                            spread=spread((p[0],), date, m), r1=sim.result(rcost, real, 0.01), r2=sim.result(rcost, real, 0.02)))
    return out


def stats(rows, a, z):
    R = sorted([r for r in rows if a <= r["date"] <= z], key=lambda r: (r["date"], r["minute"]))
    if not R: return None
    pnl = lambda r, k: dict(date=r["date"], pnl=str(1e4 * max(-1, r[k])))
    a1, d1 = account([pnl(r, "r1") for r in R]); a2, d2 = account([pnl(r, "r2") for r in R], 0.02)
    top = set(sorted(range(len(R)), key=lambda i: -R[i]["r1"])[:5])
    a5, _ = account([pnl(r, "r1") for i, r in enumerate(R) if i not in top])
    return dict(trades=len(R), winners=sum(r["r1"] > 0 for r in R), per_trade=round(sum(1e4 * max(-1, r["r1"]) for r in R) / len(R)),
                acct1=round(a1), dd1=round(d1, 4), acct2=round(a2), dd2=round(d2, 4), no_best5=round(a5),
                best5=[dict(sym=R[i]["sym"], date=R[i]["date"], pnl=round(1e4 * R[i]["r1"])) for i in sorted(top, key=lambda i: -R[i]["r1"])])


def main():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40
         and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= LAST]
    with mp.Pool(8) as pool: res = [r for rs in pool.map(one, T, chunksize=8) for r in rs]
    with open(f"{B}/opt_spread_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(res[0])); w.writeheader(); w.writerows(res)
    out = {}
    print("| Contract | Floor | Sale | 2024-25 trades | 2024-25 at 1% / drop | 2024-25 at 2% / drop | 2024-25 w/o best 5 | 2026 at 1% / drop |\n|---|---|---|---|---|---|---|---|")
    for rule in RULES:
        for floor in FLOORS:
            for sale in SALES:
                R = [r for r in res if r["rule"] == rule and r["floor"] == floor and r["sale"] == sale]
                if not R: continue
                tune, held, whole = stats(R, "2024-01-01", "2025-12-31"), stats(R, "2026-01-01", "2026-12-31"), stats(R, "", "9")
                out[f"{rule}|{floor}|{sale}"] = dict(rule=rule, floor=floor, sale=sale, tune=tune, held=held, whole=whole)
                print(f"| {rule} | {floor} | {sale} | {tune['trades']} | ${tune['acct1']:,} / {tune['dd1']:.0%} | ${tune['acct2']:,} / {tune['dd2']:.0%} | ${tune['no_best5']:,} | ${held['acct1']:,} / {held['dd1']:.0%} |", flush=True)
    json.dump(out, open(f"{B}/opt_spread_summary.json", "w"), indent=1)


if __name__ == "__main__": main()
