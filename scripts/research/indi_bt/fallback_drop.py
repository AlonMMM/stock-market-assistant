"""Fixing the drop of the contract fallbacks on bot 2.5 (the user, 2026-10-25: the two rules "make more trades but hurt the
drop very much ... cut losses or check for gain taking somehow to reduce the drop"; the grid set before running).

Version 2.5 = the D2 bonus entry (sg_c12_15) with the rest-stop champion's exits (t-stat exit, hold from +50%, the rest
at -20% after the +10 half, no failed break). "Both" = cheap_up.py's two fallbacks: the 0.15-delta option under $0.20 ->
the nearest-the-money strike at $0.20 or more; under 200 contracts in the last 30 minutes -> the nearest strike toward the
money with them (delta up to 0.35). The champion's own trades keep their exits; the fixes act on the fallback trades
(exit level) or on the account (overlay level):
  exits, fallback trades only      base | stop20 (-20% with the stock against, not -30%) | take50 (half out at +50%) |
                                   take100 (half out at +100%) | stop20+take50 | ts60 (out at 60 minutes if under water)
  overlays, all trades             none | cap3 / cap4 / cap5 new trades a day (the first by minute) | half (fallback trades
                                   at half size) | dayloss1 / dayloss1.5 (no new entry once the day's closed trades lost
                                   1 / 1.5 x the trade size)
Lists: fair list (HIS40 ∩ PRIOR[year], 2024-02..2026-10), the 151 unseen, and the favorites year (list_fav_d2, 63 stocks,
2025-10-24..2026-10-23). Account from $100,000, each trade 1% (2%) of the account at the start of its day.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs fallback_drop.py [walk|report]   (from the repo root)
  walk -> data/local/x/bt/fallback_drop.json (every signal's picks and returns); report reads it.
"""
import collections, csv, glob, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import news_filter as nf
from low_delta import HIS40, PRIOR
from tiers_round import H, NIGHT

B = "data/local/x/bt"
OUT = f"{B}/fallback_drop.json"
FA, FZ = "2025-10-24", "2026-10-23"
CHAMP = {**sim.X, **H, **NIGHT, "thesis": {"t": 0.5}, "carry_min_gain": 0.5, "after_half": dict(out=-0.2)}
US20 = {**CHAMP["user_stop"], "out": -0.2}
EXITS = {
    "base": CHAMP,
    "stop20": {**CHAMP, "user_stop": US20},
    "take50": {**CHAMP, "takes": [[0.5, 0.5]]},
    "take100": {**CHAMP, "takes": [[1.0, 0.5]]},
    "stop20+take50": {**CHAMP, "user_stop": US20, "takes": [[0.5, 0.5]]},
    "ts60": {**CHAMP, "time_stop": {"min": 60, "need": 0.0}},
}
OVERLAYS = ["none", "cap3", "cap4", "cap5", "half", "dayloss1", "dayloss1.5"]


def walk_one(t):
    """-> key, row: the pick (plain or the fallback) and the return under every exit set (plain: base only)."""
    key = [t["list"], t["date"], t["sym"], int(t["minute"])]
    minute, spot = int(t["minute"]), float(t["price"])
    row = dict(list=t["list"], date=t["date"], sym=t["sym"], minute=minute, status=t["status"], ret={})
    if t["status"] == "ok":
        csym, exp, added = t["contract"], t["expiry"], False
    else:
        c, why = cu.choose(cu.candidates(t["sym"], t["date"], minute, t["right"], spot), "both")
        if not c: row["status"] = why; return key, row
        csym, exp, added = c[0], c[1], True
        row.update(delta=round(c[3], 3), px=c[4], vol30=c[5])
    row["added"] = added
    for name, rb in EXITS.items():
        if not added and name != "base": continue
        sim.X.clear(); sim.X.update(rb)
        cost, steps, _ = sim.walk(t["sym"], t["date"], minute, t["right"], csym, exp, cu.CAL)
        if cost is None: row["status"] = "no_fill"; return key, row
        last = [s for s in steps if s[2] == "sell"][-1]
        row["ret"][name] = round(sim.result(cost, steps), 4)
        row.setdefault("exit", {})[name] = [last[0], last[1]]
        if name == "base": row["cost"] = round(cost, 2)
    row["status"] = "bought"
    return key, row


def signals():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    out = []
    for t in T:
        if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]: out.append(dict(t, list="fair"))
        elif t["sym"] not in HIS40: out.append(dict(t, list="unseen"))
    for r in json.load(open(f"{B}/list_fav_d2_{FA}_{FZ}.json")):
        s = r["status"]
        if s == "bought": out.append(dict(r, status="ok", list="fav"))
        elif s.startswith("no contract: too_cheap") or s.startswith("no contract: illiquid"): out.append(dict(r, status=s.partition(":")[2].strip(), list="fav"))
    return sorted(out, key=lambda t: (t["list"], t["date"], int(t["minute"])))


def walk():
    T = signals()
    print(len(T), "signals:", {l: dict(collections.Counter(t["status"] for t in T if t["list"] == l)) for l in ("fair", "unseen", "fav")}, flush=True)
    with mp.Pool(6) as pool: R = pool.map(walk_one, T, chunksize=8)
    json.dump([r for _, r in R], open(OUT, "w"))
    print("->", OUT, flush=True)


def account(rows, pct, overlay, exit_name):
    """rows sorted by (date, minute). -> (end, worst drop, trades taken, the rows taken with their pnl)."""
    eq, peak, dd, start = 1e5, 1e5, 0.0, 1e5
    cur = None; n_day = 0; taken = []; closed_today = []
    cap = int(overlay[3:]) if overlay.startswith("cap") else None
    dayloss = float(overlay[7:]) if overlay.startswith("dayloss") else None
    pend = []  # (exit date, exit minute, pnl in multiples of the day's size) of taken trades not yet booked
    for r in rows:
        if r["date"] != cur:
            # book the trades that closed on earlier days (the account compounds by the entry day, as score_sum.account)
            cur = r["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak); n_day = 0
        if cap is not None and n_day >= cap: continue
        name = exit_name if r["added"] else "base"
        if dayloss is not None:
            lost = sum(x for x in (p[2] for p in taken if p[0] == r["date"] and (p[0], p[1]) <= (r["date"], r["minute"])))
            if lost <= -dayloss: continue
        mult = 0.5 if overlay == "half" and r["added"] else 1.0
        ret = max(-1.0, r["ret"][name]) * mult
        ex = r["exit"][name]
        taken.append((ex[0], ex[1], ret, r))
        eq += pct * start * ret
        n_day += 1
    return eq, max(dd, 1 - eq / max(peak, eq)), [(x[3], x[2]) for x in taken]


def report():
    R = [r for r in json.load(open(OUT)) if r["status"] == "bought"]
    R.sort(key=lambda r: (r["date"], r["minute"]))
    money = lambda v: f"${v:,.0f}"
    for lname in ("fair", "unseen", "fav"):
        L = [r for r in R if r["list"] == lname]
        n_add = sum(r["added"] for r in L)
        print(f"\n### {lname}: {len(L)} trades ({len(L) - n_add} champion contracts, {n_add} fallback trades)\n")
        years = ("2024", "2025", "2026") if lname != "fav" else ()
        head = "| Exits (fallback trades) | Overlay | Trades | Winners | Per trade at $10K | At 1% / worst drop | At 2% / worst drop | " + ("2024 / 2025 / 2026 at $10K | " if years else "") + "Without the best 5 at 1% | Fallback trades: n, per trade |"
        print(head)
        print("|" + "---|" * (head.count("|") - 1))
        for ex in EXITS:
            for ov in OVERLAYS:
                if ex != "base" and ov != "none" and ov not in ("cap4", "dayloss1"): continue  # the full grid on base; the exits x two overlays
                a1, d1, taken = account(L, 0.01, ov, ex)
                a2, d2, _ = account(L, 0.02, ov, ex)
                pn = [p for _, p in taken]
                top = set(sorted(range(len(taken)), key=lambda i: -pn[i])[:5])
                a5, _, _ = account([r for i, (r, _) in enumerate(taken) if i not in top], 0.01, "none" if ov not in ("half",) else ov, ex)
                yr = " / ".join(f"{sum(p for (r, p) in taken if r['date'][:4] == y) * 1e4 / 1e3:+,.0f}K" for y in years)
                add = [p for r, p in taken if r["added"]]
                print(f"| {ex} | {ov} | {len(taken)} | {sum(p > 0 for p in pn)} | {st.fmean(pn) * 1e4:+,.0f} | {money(a1)} / {100 * d1:.0f}% | {money(a2)} / {100 * d2:.0f}% | " + (f"{yr} | " if years else "") + f"{money(a5)} | {len(add)}, {st.fmean(add) * 1e4 if add else 0:+,.0f} |")
        # the champion alone (no fallback) for the bar
        P = [r for r in L if not r["added"]]
        a1, d1, taken = account(P, 0.01, "none", "base"); a2, d2, _ = account(P, 0.02, "none", "base")
        pn = [p for _, p in taken]
        yr = " / ".join(f"{sum(p for (r, p) in taken if r['date'][:4] == y) * 1e4 / 1e3:+,.0f}K" for y in years)
        print(f"| 2.5 alone (no fallback) | - | {len(taken)} | {sum(p > 0 for p in pn)} | {st.fmean(pn) * 1e4:+,.0f} | {money(a1)} / {100 * d1:.0f}% | {money(a2)} / {100 * d2:.0f}% | " + (f"{yr} | " if years else "") + " | |")
        # trades a day
        n = collections.Counter(r["date"] for r in L)
        print(f"\ntrades a day: mean {st.fmean(n.values()):.2f}, max {max(n.values())}, days with 5+ {sum(v >= 5 for v in n.values())} of {len(n)}")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "walk"
    walk() if mode == "walk" else report()
