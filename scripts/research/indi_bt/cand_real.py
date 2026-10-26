"""More candidates, on real quotes (the user, 2026-10-26: "lets try to find more candidates - after that we will take the
candidate and test them on my favorite"). Tuned on 2024-2025; 2026 is the held-out check. The fair list, priced on the
real best bid/ask (Databento OPRA cbbo-1m, as real_bench.py: a buy at the mid + half the way to the ask, a sale at the
bid). Built on 2.6 (c12_15 entries, the CHAMP exits, the cheap fallback). Set before running:

  delta      the pick's target delta: 0.15 (2.6), 0.20, 0.25, 0.30 (the cheap fallback and the 200-contract floor as now).
             On real costs a dearer contract pays a smaller share of its price in spread.
  path       what the exits read: "trades" (the option's 1-minute trade bars, as always; stale on a thin contract),
             "mid" (the real quote's mid every minute), "bid" (the real bid every minute): the -30% stop, the checks and
             the +50% hold decided on that price. Fills are the real quotes either way.
  sizing     (on each delta and path) flat; "fb-half" (a cheap-fallback trade at half size); "tiers" (200-499 contracts
             in 30 minutes at half size, 500+ full); "pyramid" (d2_scale.py: a D2 entry, t < 1.8, at full size, plus half
             a size of 2.4's own entry when the same stock reaches t >= 1.8 later that day, the same side, while the D2
             position is still held and above its cost on the real mid); "pyramid+fb-half".
Each leg's overnight cap at its own size; $0.62 a contract each way.

  node --env-file=.env <dir>/run.mjs cand_real.py      (from the app repo root)
-> data/local/x/bt/cand_real_summary.json, cand_real_trades.csv
"""
import csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import news_filter as nf
import real_bench as RB
import opt_spread as OS
from d2_failed_break import CHAMP
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = RB.CAL
C = sim.C
LAST = RB.LAST
DELTAS = (0.15, 0.20, 0.25, 0.30)
PATHS = ("trades", "mid", "bid")
_day = sim.day
PATH = {"mode": "trades", "contract": None}


def quote_day(sym, date):
    """sim's bars for the walked contract, from its quotes: one bar a minute at the price the exits should read."""
    if PATH["mode"] == "trades" or sym != PATH["contract"]: return _day(sym, date)
    q = RB.book(date).get(sym)
    if not q: return _day(sym, date)
    vol = {b[0]: b[5] for b in _day(sym, date)}
    out = []
    for m, bid, ask in q:
        p = (bid + ask) / 2 if PATH["mode"] == "mid" else bid
        bm = m - 1  # the book as minute m began = the end of minute m - 1
        if 0 <= bm < 390: out.append([bm, p, p, p, p, vol.get(bm, 0)])
    return out


sim.day = quote_day


def pick(t, delta):
    m, spot = int(t["minute"]), float(t["price"])
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], spot)
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - delta))
    src = "pick"
    if best[4] < C["min_price"]:
        ok = [c for c in cands if c[4] >= C["min_price"] and abs(c[3]) >= abs(best[3])]
        if not ok: return None
        best = min(ok, key=lambda c: c[4]); src = "cheap"
    if best[5] < C["min_vol30"]: return None
    return best, src


def walk(t, contract, expiry, path):
    PATH["mode"], PATH["contract"] = path, contract
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], contract, expiry, CAL)
    PATH["mode"], PATH["contract"] = "trades", None
    return cost, steps


def one(job):
    kind, t = job
    out = []
    deltas = DELTAS if kind == "main" else (0.15,)
    for delta in deltas:
        p = pick(t, delta)
        if not p: continue
        c, src = p
        for path in PATHS:
            cost, steps = walk(t, c[0], c[1], path)
            if cost is None: continue
            rcost, real = OS.price(steps, c[0], cost, "bid")
            row = dict(kind=kind, delta=delta, path=path, date=t["date"], sym=t["sym"], right=t["right"], minute=int(t["minute"]),
                       contract=c[0], src=src, v30=c[5], d2=int(float(t.get("c_t") or 9) < 1.8), cost=rcost,
                       r1=sim.result(rcost, real, 0.01), r05=sim.result(rcost, real, 0.005))
            if kind == "main":
                # the share still held and the real mid against the real cost, minute by minute on the entry day (pyramid)
                sold, held = 0.0, {}
                sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
                for m in range(int(t["minute"]), 390):
                    sold = sum(s[3] for s in sells if s[1] <= m)
                    k = RB.quote(c[0], t["date"], m)
                    held[m] = (1 - sold, None if not k else (k[0] + k[1]) / 2 / rcost - 1)
                row["held"] = held
            out.append(row)
    return out


def curve(entries):
    """entries: (date, minute, size, ret at that size's cap) -> stats at 1% a unit."""
    R = sorted(entries)
    return R


def stats(R, a, z):
    R = sorted([r for r in R if a <= r[0] <= z])
    if not R: return None
    pnl = [dict(date=d, pnl=str(1e4 * s * max(-1, x))) for d, m, s, x, sym in R]
    a1, d1 = account(pnl)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top])
    return dict(trades=len(R), winners=sum(x > 0 for _, _, _, x, _ in R), per_trade=round(sum(1e4 * s * max(-1, x) for _, _, s, x, _ in R) / len(R)),
                acct1=round(a1), dd1=round(d1, 4), no_best5=round(a5),
                best5=[dict(sym=R[i][4], date=R[i][0], pnl=round(1e4 * R[i][2] * R[i][3])) for i in sorted(top, key=lambda i: -R[i][2] * R[i][3])])


def main():
    def load(prefix):
        T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
        nf.features(T)
        return [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40
                and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= LAST]
    jobs = [("main", t) for t in load("sg_c12_15")] + [("add", t) for t in load("s_t18r15")]
    with mp.Pool(8) as pool: res = [r for rs in pool.map(one, jobs, chunksize=8) for r in rs]
    main_rows = [r for r in res if r["kind"] == "main"]
    adds = {}
    for r in res:
        if r["kind"] == "add": adds.setdefault((r["date"], r["sym"], r["right"], r["path"]), []).append(r)
    out = {}
    for delta in DELTAS:
        for path in PATHS:
            M = [r for r in main_rows if r["delta"] == delta and r["path"] == path]
            if not M: continue
            for sizing in ("flat", "fb-half", "tiers", "pyramid", "pyramid+fb-half"):
                E = []
                for r in M:
                    s = 1.0
                    if "fb-half" in sizing and r["src"] == "cheap": s = 0.5
                    if sizing == "tiers" and r["v30"] < 500: s = 0.5
                    E.append((r["date"], r["minute"], s, r["r1"] if s == 1 else r["r05"], r["sym"]))
                    if "pyramid" in sizing and r["d2"]:
                        for a in sorted(adds.get((r["date"], r["sym"], r["right"], path), []), key=lambda x: x["minute"]):
                            if a["minute"] <= r["minute"]: continue
                            share, up = r["held"].get(a["minute"], (0, None))
                            if share > 0 and up is not None and up > 0: E.append((a["date"], a["minute"], 0.5, a["r05"], a["sym"]))
                            break
                key = f"{delta}|{path}|{sizing}"
                out[key] = dict(delta=delta, path=path, sizing=sizing, tune=stats(E, "2024-01-01", "2025-12-31"),
                                held=stats(E, "2026-01-01", "2026-12-31"), whole=stats(E, "", "9"))
                t, h = out[key]["tune"], out[key]["held"]
                print(f"| {delta} | {path} | {sizing} | {t['trades']} | ${t['acct1']:,} / {t['dd1']:.0%} | ${t['no_best5']:,} | ${h['acct1']:,} / {h['dd1']:.0%} |", flush=True)
    json.dump(out, open(f"{B}/cand_real_summary.json", "w"), indent=1)


if __name__ == "__main__": main()
