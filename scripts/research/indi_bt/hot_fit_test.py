"""The fair list plus the hot stocks (the user, 2026-10-25: "check the test stocks to be both the core and the hot
stocks ... looking 3 to 6 months before"; then only the hot stocks whose options fit the bot, "you can go up to 0.3
delta because we gonna have a rule fallback there to test"). The hot stocks are hot_universe.py's monthly top 50 of
the whole optionable market (6- and 3-month lookbacks), minus the core 40, kept to the 67 whose weekly 0.15-delta
option, or the fallback up to 0.30, is liquid (opt_fit.py). A hot stock trades only in the months it is hot. Their
signals are lists.py's runs hotfit_24 (bot 2.4) and hotfit_25 (2.5, the D2 bonus entry); the fair list is the trade
files of the two entries. Every signal is walked again with the version's exits; the fallbacks (cheap_up2.py) re-pick
the too-cheap and illiquid ones. 1% / 2% from $100,000 with the 10% overnight cap at each size, Feb 2024 - Oct 2026.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs hot_fit_test.py      (from the repo root)
"""
import collections, csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import cheap_up2 as cu2
C = sim.C
import news_filter as nf
from store import calendar
from low_delta import HIS40, PRIOR
from score_sum import account, held
from d2_failed_break import CHAMP

B = "data/local/x/bt"
CAL = calendar()
A, Z = "2024-02-01", "2026-10-23"
VERSIONS = {"2.4": ("s_t18r15", "hotfit_24", cu2.BOT24), "2.5": ("sg_c12_15", "hotfit_25", CHAMP)}
MODES = ("plain", "cheap", "liquid2", "both2", "adj", "cheap_adj")
HOT6 = {m: set(v) for m, v in json.load(open(f"{B}/hot_6m.json")).items()}


def adjacent(cands, best, und, right):
    """The user's liquid fallback (2026-10-25: "just check one above and one below the delta if there is no liquid ...
    247.5 ... 250"): when the 0.15-delta strike is illiquid, the next listed strike on each side (OTM only), the one
    that has min_vol30 contracts and costs min_price or more; both -> the nearer to 0.15 delta."""
    ks = sorted(sim.chain(und, best[1], right))
    i = ks.index(best[2])
    near = {ks[j] for j in (i - 1, i + 1) if 0 <= j < len(ks)}
    ok = [c for c in cands if c[2] in near and c[5] >= C["min_vol30"] and c[4] >= C["min_price"]]
    return min(ok, key=lambda c: abs(abs(c[3]) - C["delta"])) if ok else None


def choose(cands, mode, und, right):
    if mode not in ("adj", "cheap_adj"): return cu2.choose(cands, mode)
    c, why = cu.choose(cands, "cheap" if mode == "cheap_adj" else "plain")
    if c or why != "illiquid": return c, why
    best = min(cands, key=lambda x: abs(x[3] - C["delta"]))
    if mode == "cheap_adj" and best[4] < C["min_price"]:
        best = min((x for x in cands if x[4] >= C["min_price"] and abs(x[3]) >= abs(best[3])), key=lambda x: x[4])
    return adjacent(cands, best, und, right), "illiquid"


def one(t):
    minute = int(t["minute"])
    cands = cu.candidates(t["sym"], t["date"], minute, t["right"], float(t["price"])) if t["status"] in ("too_cheap", "illiquid") else []
    out = {}
    for mode in MODES:
        if t["status"] == "ok": p = (t["contract"], t["expiry"])
        elif mode == "plain": continue
        else:
            c, _ = choose(cands, mode, t["sym"], t["right"])
            if not c: continue
            p = (c[0], c[1])
        sim.X.clear(); sim.X.update(VERSIONS[t["v"]][2])
        cost, steps, _ = sim.walk(t["sym"], t["date"], minute, t["right"], p[0], p[1], CAL)
        if cost is not None: out[mode] = (sim.result(cost, steps, 0.01), sim.result(cost, steps, 0.02), held(cost, steps))  # the overnight cap at each size
    return t["k"], out


def signals(v):
    prefix, hot, _ = VERSIONS[v]
    F = [dict(t, v=v, src="fair") for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(F)
    F = [t for t in F if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    for t in F:
        if t["sym"] not in HIS40: t["src"] = "unseen"  # the 151 unseen: the fallbacks' check (the user, 2026-10-25: "add both fallback features")
    F = [t for t in F if t["src"] == "unseen" or t["sym"] in PRIOR[t["date"][:4]]]
    H = []
    for r in json.load(open(f"{B}/list_{hot}_{A}_{Z}.json")):
        st = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}.get(r["status"])
        if not st: continue
        src = "hot 6m" if r["sym"] in HOT6.get(r["date"][:7], ()) else "hot 3m only"
        H.append(dict(r, status=st, v=v, src=src, minute=str(r["minute"])))
    out = F + H
    for t in out: t["k"] = (v, t["src"], t["date"], t["sym"], t["minute"])
    return out


def main():
    T = signals("2.4") + signals("2.5")
    T.sort(key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = dict(pool.map(one, T, chunksize=8))
    pt = lambda x: 1e4 * max(-1, x)
    LISTS = [("fair list, full period", lambda t: t["src"] == "fair"),
             ("151 unseen", lambda t: t["src"] == "unseen"),
             ("fair list from Feb 2024", lambda t: t["src"] == "fair" and t["date"] >= A),
             ("hot 6m", lambda t: t["src"] == "hot 6m"),
             ("hot 3m only", lambda t: t["src"] == "hot 3m only"),
             ("fair + hot 6m", lambda t: t["date"] >= A and t["src"] in ("fair", "hot 6m")),
             ("fair + hot 6m + 3m", lambda t: t["date"] >= A and t["src"] != "unseen")]
    for v in VERSIONS:
        print(f"\n## Bot {v}\n")
        print("| List | Pick | Trades | Winners | Per trade at $10K | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Best 5 |\n|---|---|---|---|---|---|---|---|---|---|")
        for lname, lf in LISTS:
            L = [t for t in T if t["v"] == v and lf(t)]
            for mode in MODES:
                rows = [dict(date=t["date"], pnl=str(pt(R[t["k"]][mode][0])), sym=t["sym"], **R[t["k"]][mode][2]) for t in L if mode in R[t["k"]]]
                if not rows: continue
                a1, d1 = account(rows)
                a2, d2 = account([dict(date=t["date"], pnl=str(pt(R[t["k"]][mode][1])), **R[t["k"]][mode][2]) for t in L if mode in R[t["k"]]], 0.02)
                top = sorted(range(len(rows)), key=lambda i: -float(rows[i]["pnl"]))[:5]
                a5, _ = account([r for i, r in enumerate(rows) if i not in set(top)])
                yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
                per = sum(float(r["pnl"]) for r in rows) / len(rows)
                best = ", ".join(f"{rows[i]['sym']} {rows[i]['date'][2:]} {float(rows[i]['pnl']) / 1e3:+,.0f}K" for i in top)
                print(f"| {lname} | {mode} | {len(rows)} | {sum(float(r['pnl']) > 0 for r in rows)} | {per:+,.0f} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {best} |", flush=True)
        for mode in ("plain", "adj"):
            by = collections.defaultdict(list)
            for t in T:
                if t["v"] == v and t["src"].startswith("hot") and mode in R[t["k"]]: by[t["sym"]].append(pt(R[t["k"]][mode][0]))
            print(f"\nBot {v}, hot stocks by stock ({mode}): " + ", ".join(f"{s} {len(x)} {sum(x) / 1e3:+,.0f}K" for s, x in sorted(by.items(), key=lambda kv: -sum(kv[1]))))


if __name__ == "__main__":
    main()
