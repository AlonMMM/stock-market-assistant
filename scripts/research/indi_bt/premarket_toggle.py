"""The pre-market volume skip, on and off, after all the changes (the user, 2026-10-27: "can you ran a test for this
toggle of an on after all of our changes on indi fair list 2024-2025?"). The live bot runs 2.6* with the skip off; the
default (and every backtest so far) skips a stock whose pre-market volume is 4x its prior median or more.

On real quotes (real_bench.py / cand_real.py: a buy at the mid + half the way to the ask, a sale at the bid, $0.62 a
contract each way, the 10% overnight cap at each size), the fair list, the earnings filter kept. Set before running:
  bots   2.6 (c12_15 entries, CHAMP exits, the cheap fallback under $0.20); live 2.6* (the same, minimum price $0.15);
         the pyramid on 2.6 (cand_real.py: the half-size add on the real signal while the D2 leg is held and up)
  skip   off; 3x; 4x (the default); 6x
Tuned on 2024-2025; 2026 (to 16 Oct) is the held-out column.

  node --env-file=.env <dir>/run.mjs premarket_toggle.py      (from the app repo root)
-> data/local/x/bt/premarket_toggle_summary.json, premarket_toggle_trades.csv
"""
import csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cand_real as CR
import news_filter as nf
import real_bench as RB
import opt_spread as OS
from low_delta import HIS40, PRIOR
from score_sum import account, held as booked

B = "data/local/x/bt"
LAST = RB.LAST
BOTS = {"2.6": 0.20, "2.6*": 0.15}
SKIPS = {"off": None, "3x": 3, "4x": 4, "6x": 6}


def one(job):
    kind, bot, t = job
    sim.C["min_price"] = BOTS[bot]
    p = CR.pick(t, 0.15)
    if not p: return None
    c, src = p
    cost, steps = CR.walk(t, c[0], c[1], "trades")
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    row = dict(kind=kind, bot=bot, date=t["date"], sym=t["sym"], right=t["right"], minute=int(t["minute"]), contract=c[0],
               src=src, d2=int(float(t.get("c_t") or 9) < 1.8), pre_rvol=t["pre_rvol"], cost=rcost,
               **{f"r{k}": sim.result(rcost, real, s) for k, s in (("05", 0.005), ("1", 0.01), ("2", 0.02))},
               h=booked(rcost, real))
    if kind == "main":
        sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
        held = {}
        for m in range(int(t["minute"]), 390):
            k = RB.quote(c[0], t["date"], m)
            held[m] = (1 - sum(s[3] for s in sells if s[1] <= m), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
        row["held"] = held
    return row


def stats(E, a, z):
    """E: (date, minute, units, ret at 1% a unit's size, ret at 2%, sym, held())."""
    R = sorted((e for e in E if a <= e[0] <= z), key=lambda e: e[:6])
    if not R: return None
    bk = lambda u, h: dict(exit_day=h["exit_day"], marks={k: u * v for k, v in h["marks"].items()})  # booked on the sale day
    p1 = [dict(date=d, pnl=str(1e4 * u * max(-1, x)), **bk(u, h)) for d, m, u, x, _, s, h in R]
    p2 = [dict(date=d, pnl=str(1e4 * u * max(-1, y)), **bk(u, h)) for d, m, u, _, y, s, h in R]
    a1, d1 = account(p1)
    a2, d2 = account(p2, 0.02)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(p1) if i not in top])
    yr = {y: round(sum(1e4 * u * max(-1, x) for d, m, u, x, _, s, _ in R if d[:4] == y)) for y in ("2024", "2025", "2026")}
    return dict(trades=len(R), winners=sum(x > 0 for _, _, _, x, _, _, _ in R),
                per_trade=round(sum(1e4 * u * max(-1, x) for _, _, u, x, _, _, _ in R) / len(R)),
                acct1=round(a1), dd1=round(d1, 4), acct2=round(a2), dd2=round(d2, 4), no_best5=round(a5), years=yr,
                best5=[dict(sym=R[i][5], date=R[i][0], pnl=round(1e4 * R[i][2] * R[i][3])) for i in sorted(top, key=lambda i: -R[i][2] * R[i][3])])


def kept(r, skip):
    return skip is None or r["pre_rvol"] is None or r["pre_rvol"] < skip


def entries(M, adds, skip, pyramid):
    E = []
    for r in M:
        if not kept(r, skip): continue
        E.append((r["date"], r["minute"], 1.0, r["r1"], r["r2"], r["sym"], r["h"]))
        if not (pyramid and r["d2"]): continue
        for a in sorted(adds.get((r["date"], r["sym"], r["right"], r["bot"]), []), key=lambda x: x["minute"]):
            if a["minute"] <= r["minute"]: continue
            share, up = r["held"].get(a["minute"], (0, None))
            # half a size: the 1% curve reads the 0.5% return, the 2% curve the 1% return
            if share > 0 and up is not None and up > 0: E.append((a["date"], a["minute"], 0.5, a["r05"], a["r1"], a["sym"], a["h"]))
            break
    return E


def main():
    def load(prefix):
        T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
        nf.features(T)
        return [t for t in T if t["e_next"] != 0 and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= LAST]
    main_t, add_t = load("sg_c12_15"), load("s_t18r15")
    jobs = [("main", b, t) for b in BOTS for t in main_t] + [("add", "2.6", t) for t in add_t]
    with mp.Pool(8) as pool: res = [r for r in pool.map(one, jobs, chunksize=8) if r]
    with open(f"{B}/premarket_toggle_trades.csv", "w") as f:
        cols = [k for k in res[0] if k not in ("held", "h")]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore"); w.writeheader(); w.writerows(res)
    adds = {}
    for r in res:
        if r["kind"] == "add": adds.setdefault((r["date"], r["sym"], r["right"], r["bot"]), []).append(r)
    out = {}
    print("| Bot | Skip | Trades 24-25 | Winners | Per trade | 1% / drop | 2% / drop | 2024 / 2025 | No best 5 | 2026 held-out 1% / drop |\n|---|---|---|---|---|---|---|---|---|---|")
    for bot, pyramid in (("2.6", False), ("2.6*", False), ("2.6", True)):
        name = "pyramid" if pyramid else bot
        M = [r for r in res if r["kind"] == "main" and r["bot"] == bot]
        for skip_name, skip in SKIPS.items():
            E = entries(M, adds, skip, pyramid)
            t, h = stats(E, "2024-01-01", "2025-12-31"), stats(E, "2026-01-01", "2026-12-31")
            skipped = [r for r in M if not kept(r, skip) and r["date"] <= "2025-12-31"]
            out[f"{name}|{skip_name}"] = dict(bot=name, skip=skip_name, tune=t, held=h, whole=stats(E, "", "9"),
                                              skipped=[dict(date=r["date"], sym=r["sym"], right=r["right"], pre_rvol=round(r["pre_rvol"], 1),
                                                            pnl=round(1e4 * r["r1"])) for r in skipped])
            print(f"| {name} | {skip_name} | {t['trades']} | {t['winners']} | {t['per_trade']:+,} | ${t['acct1']:,} / {t['dd1']:.0%} | ${t['acct2']:,} / {t['dd2']:.0%} | "
                  f"{t['years']['2024']:+,} / {t['years']['2025']:+,} | ${t['no_best5']:,} | ${h['acct1']:,} / {h['dd1']:.0%} |", flush=True)
    json.dump(out, open(f"{B}/premarket_toggle_summary.json", "w"), indent=1)


if __name__ == "__main__": main()
