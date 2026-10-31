"""The champion (2.7 at minute fills) on 2022-2023 with MODELED options (the user, 2026-10-31: "lets start with
Black-Scholes"; bsmodel.py: Black-Scholes on the stock's minute bars, volatility 1.43 x the 20-day realized). No option
prices exist here before Feb 2024; the model is checked on 2024-26 against the real Alpaca option bars of the same
signals, walked the same way.

Signals: defence_signals.py on his 40 + the 60 Favorites, Jan 2022 - Oct 2026: main = c12_15 (the champion's entry),
adds = base (t >= 1.8, volume >= 1.5x: the pyramid's confirmation); the news filter where its data exists (none in
2022). Contract and exits: the champion's (fe.choose at $0.20, IBIT $0.10, the 200-contract floor; d2_failed_break.CHAMP),
fills at the bar model (+-2% and commissions, sim.result), not real quotes. The pyramid as runup.py: a D2 entry
(t < 1.8) gets half a size more at the first later base signal while the first leg is held and up.
Lists: "his 40" (P["universe"], the nearest thing to the fair list before 2024) and "Favorites" (favorites.txt), each its
own account from $100,000 each year, 2% and 3% a trade, the 10% overnight cap at each size.

  node --env-file=.env <dir>/run.mjs bs22.py      (from the app repo root)
-> data/local/x/bt/bs22_summary.json, bs22_trades.csv
"""
import collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ["BT_RULES"] = "c12_15,base"
import defence_signals as DS
import bsmodel as M
import sim
import cheap_up as cu
import fav_real as FR
import floor_exception as fe
import news_filter as nf
from d2_failed_break import CHAMP
from score_sum import account
from store import P, calendar, day

B = "data/local/x/bt"
DS.SPAN = {"2022": ("2022-01-03", "2022-12-30"), "2023": ("2023-01-03", "2023-12-29"), "2024": ("2024-02-01", "2024-12-31"),
           "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-16")}
HIS = set(P["universe"]); FAV = set(FR.FAV)
U = sorted((HIS | FAV) - {"SPY"})
CAL = calendar()
SIZES = {0.02: ("r2", "r1"), 0.03: ("r3", "r15")}
YEARS = ("2022", "2023", "2024", "2025", "2026")


def sigs(sym):
    o = DS.stock(sym)
    return [dict(r, kind="main") for r in o["c12_15"]] + [dict(r, kind="add") for r in o["base"]]


def walk(job):
    mode, t = job
    M.set_model(mode == "model")
    m = int(t["minute"])
    try:
        cands = cu.candidates(t["sym"], t["date"], m, t["right"], float(t["price"]))
        p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
        if not p: return None
        c = p[0]
        sim.X.clear(); sim.X.update(CHAMP)
        cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
        if cost is None: return None
        r = {k: sim.result(cost, steps, z) for k, z in (("r1", 0.01), ("r15", 0.015), ("r2", 0.02), ("r3", 0.03))}
        sells = [s for s in steps if s[2] == "sell" and s[0] == t["date"]]
        bars = {b[0]: b[4] for b in day(c[0], t["date"])}
        held, last = {}, None
        for mm in range(m, 390):
            last = bars.get(mm, last)
            held[mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if last is None else last / cost - 1)
        return dict(mode=mode, kind=t["kind"], date=t["date"], minute=m, sym=t["sym"], right=t["right"],
                    d2=int(float(t["c_t"]) < 1.8), news_ok=t["news_ok"], iv=c[6], delta=c[3], cost=cost,
                    over=int(any(s[2] == "carry" for s in steps)), held=held, **r)
    except Exception as e:
        return dict(mode=mode, error=f"{type(e).__name__}: {e}", sym=t["sym"], date=t["date"])


def entries(R, mode, lst, year, size):
    full, halfk = SIZES[size]
    main = [r for r in R if r["mode"] == mode and r["kind"] == "main" and r["date"][:4] == year and r["sym"] in lst and r["news_ok"]]
    adds = collections.defaultdict(list)
    for r in R:
        if r["mode"] == mode and r["kind"] == "add" and r["date"][:4] == year and r["sym"] in lst: adds[(r["date"], r["sym"], r["right"])].append(r)
    E = []
    for r in main:
        E.append((r["date"], r["minute"], 1.0, r[full]))
        if not r["d2"]: continue
        for a in sorted(adds[(r["date"], r["sym"], r["right"])], key=lambda q: q["minute"]):
            if a["minute"] <= r["minute"]: continue
            share, up = r["held"].get(a["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((a["date"], a["minute"], 0.5, a[halfk]))
            break
    return E


def stats(E, size):
    R = sorted(E)
    usd = [1e4 * e[2] * max(-1, e[3]) for e in R]
    pnl = [dict(date=e[0], pnl=str(u)) for e, u in zip(R, usd)]
    acct, dd = account(pnl, size)
    top = sorted(range(len(R)), key=lambda i: -usd[i])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in set(top[:5])], size)
    g = [i for i in range(len(R)) if R[i][3] >= 3]
    return dict(n=len(R), win=sum(e[3] > 0 for e in R) / max(1, len(R)), per=sum(usd) / max(1, len(R)), med=st.median(usd) if usd else 0,
                acct=acct, dd=dd, no5=a5, giants=len(g), nongiant=sum(u for i, u in enumerate(usd) if i not in set(g)))


def main():
    with mp.Pool(8) as pool: S = [r for part in pool.map(sigs, U) for r in part]
    nf.features(S)
    for r in S: r["news_ok"] = int(r["e_next"] != 0 and (r["pre_rvol"] is None or r["pre_rvol"] < 4))
    print(len(S), "signals (main + adds)", dict(collections.Counter((r["date"][:4], r["kind"]) for r in S)), flush=True)
    jobs = [("model", t) for t in S] + [("real", t) for t in S if t["date"] >= "2024-02-01"]
    with mp.Pool(8) as pool: R = [r for r in pool.imap_unordered(walk, jobs, chunksize=8) if r]
    err = [r for r in R if "error" in r]
    R = [r for r in R if "error" not in r]
    print(len(R), "walked;", len(err), "errors", collections.Counter(e["error"][:60] for e in err).most_common(5), flush=True)
    with open(f"{B}/bs22_trades.csv", "w") as f:
        cols = [k for k in R[0] if k != "held"]
        w = csv.DictWriter(f, cols, extrasaction="ignore"); w.writeheader(); w.writerows(R)
    out = {}
    for size in SIZES:
        print(f"\n### {size:.0%} a trade, each year its own account from $100,000 (MODELED options; 'real' = Alpaca option bars, the bar model)\n")
        print("| List | Year | Data | Trades | Winners | Per trade at $10K | Median | End / worst drop | Without the best 5 | Giants · non-giant sum |\n|---|---|---|---|---|---|---|---|---|---|")
        for ln, lst in (("his 40", HIS), ("Favorites", FAV)):
            for y in YEARS:
                for mode in ("model", "real"):
                    if mode == "real" and y < "2024": continue
                    s = stats(entries(R, mode, lst, y, size), size); out[f"{size}|{ln}|{y}|{mode}"] = s
                    print(f"| {ln} | {y} | {mode} | {s['n']} | {s['win']:.0%} | {s['per']:+,.0f} | {s['med']:+,.0f} | ${s['acct']:,.0f} / {s['dd']:.0%} | ${s['no5']:,.0f} | {s['giants']} · {s['nongiant']:+,.0f} |", flush=True)
    # the model vs the real bars, trade by trade, 2024-26 (main legs on both)
    key = lambda r: (r["date"], r["sym"], r["right"], r["minute"], r["kind"])
    mod = {key(r): r for r in R if r["mode"] == "model" and r["date"] >= "2024-02-01"}
    pairs = [(mod[key(r)], r) for r in R if r["mode"] == "real" and key(r) in mod]
    if pairs:
        print(f"\n### The model against the real bars, the same {len(pairs)} legs (2024-26)\n")
        print(f"IV at the pick: model median {st.median(p[0]['iv'] for p in pairs):.2f}, real {st.median(p[1]['iv'] for p in pairs):.2f}; "
              f"cost ratio model/real median {st.median(p[0]['cost'] / p[1]['cost'] for p in pairs):.2f}")
        print(f"return at 2%: model mean {st.mean(p[0]['r2'] for p in pairs):+.3f}, real {st.mean(p[1]['r2'] for p in pairs):+.3f}; "
              f"same sign {sum((p[0]['r2'] > 0) == (p[1]['r2'] > 0) for p in pairs) / len(pairs):.0%}; "
              f"giants model {sum(p[0]['r2'] >= 3 for p in pairs)}, real {sum(p[1]['r2'] >= 3 for p in pairs)}, both {sum(p[0]['r2'] >= 3 and p[1]['r2'] >= 3 for p in pairs)}")
    json.dump(out, open(f"{B}/bs22_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
