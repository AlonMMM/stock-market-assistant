"""cheap_up.py's contract fallbacks on the user's Favorites year (lists.py favorites_23: the app's 63 favorites,
2025-10-24 to 2026-10-23, the live bot 2.3's exits). The bought signals are walked again (the baseline must match the
list's summary), the too-cheap and illiquid ones are re-picked with each fallback and walked.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs fav_cheap_up.py      (from the repo root)
"""
import json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
from lists import account

A, Z, NAME = "2025-10-24", "2026-10-23", "favorites_23"
EXITS = [("Bot 2.3", cu.BOT)]


def one(r):
    key = (r["date"], r["sym"], r["minute"])
    status = r["status"].split(":")[0]
    why = r["status"].partition(":")[2].strip()
    out = {}
    minute, spot = int(r["minute"]), float(r["price"])
    picks = {}
    if status == "bought": picks["plain"] = (r["contract"], r["expiry"], None)
    cands = cu.candidates(r["sym"], r["date"], minute, r["right"], spot) if why in ("too_cheap", "illiquid") else []
    for mode in ("cheap", "liquid", "both"):
        if status == "bought": picks[mode] = picks["plain"]; continue
        c, _ = cu.choose(cands, mode)
        picks[mode] = (c[0], c[1], c) if c else None
    for mode, p in picks.items():
        if not p: continue
        csym, exp, c = p
        for name, rb in EXITS:
            sim.X.clear(); sim.X.update(rb)
            cost, steps, _ = sim.walk(r["sym"], r["date"], minute, r["right"], csym, exp, cu.CAL)
            if cost is None: continue
            out[f"{name}|{mode}"] = sim.result(cost, steps)
            if c: out[f"{name}|{mode}|pick"] = (round(c[3], 3), c[4], c[5])
    return key, out


def main():
    W = json.load(open(f"{cu.B}/list_{NAME}_{A}_{Z}.json"))
    W = [r for r in W if r["status"] == "bought" or r["status"].startswith("no contract: too_cheap") or r["status"].startswith("no contract: illiquid")]
    print(len(W), "signals:", {s: sum(r["status"].startswith(s) for r in W) for s in ("bought", "no contract: too_cheap", "no contract: illiquid")}, flush=True)
    with mp.Pool(6) as pool: R = dict(pool.map(one, W, chunksize=8))
    key = lambda r: (r["date"], r["sym"], r["minute"])
    print(f"\n### Favorites (63), {A} to {Z}, the live bot 2.3's exits\n")
    print("| Pick | Trades | Winners | Per trade at $10K | At 1% / worst drop | At 2% / worst drop | Without the best 5 at 1% | Added trades: n, winners, per trade, sum at $10K |\n|---|---|---|---|---|---|---|---|")
    for name, _ in EXITS:
        for mode in ("plain", "cheap", "liquid", "both"):
            k = f"{name}|{mode}"
            rows = [dict(date=r["date"], ret=max(-1, R[key(r)][k]), sym=r["sym"], added=r["status"] != "bought") for r in W if k in R[key(r)]]
            a1, d1 = account(rows, 0.01); a2, d2 = account(rows, 0.02)
            top = set(sorted(range(len(rows)), key=lambda i: -rows[i]["ret"])[:5])
            a5, _ = account([x for i, x in enumerate(rows) if i not in top], 0.01)
            add = [1e4 * x["ret"] for x in rows if x["added"]]
            added = f"{len(add)}, {sum(x > 0 for x in add)}, {st.mean(add):+,.0f}, {sum(add) / 1e3:+,.0f}K" if add else ""
            print(f"| {mode} | {len(rows)} | {sum(x['ret'] > 0 for x in rows)} | {1e4 * st.mean(x['ret'] for x in rows):+,.0f} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | ${a5:,.0f} | {added} |")
    for mode in ("cheap", "liquid"):
        k = f"Bot 2.3|{mode}"
        add = sorted(((1e4 * max(-1, R[key(r)][k]), r["sym"], r["date"], R[key(r)][k + "|pick"]) for r in W if r["status"] != "bought" and k in R[key(r)]), reverse=True)
        if not add: continue
        print(f"\n{mode}: picks delta median {st.median(p[0] for *_, p in add):.2f}, price median ${st.median(p[1] for *_, p in add):.2f}; best", [(s, d, f"{x:+,.0f}") for x, s, d, _ in add[:5]], "worst", [(s, d, f"{x:+,.0f}") for x, s, d, _ in add[-3:]])
        by = {}
        for x, s, d, _ in add: by.setdefault(s, []).append(x)
        ranked = sorted(by.items(), key=lambda kv: -sum(kv[1]))
        print(f"{mode}: by stock (sum, n): best", [(s, f"{sum(v) / 1e3:+,.0f}K", len(v)) for s, v in ranked[:6]], "worst", [(s, f"{sum(v) / 1e3:+,.0f}K", len(v)) for s, v in ranked[-6:]])
        yrs = {}
        for x, s, d, _ in add: yrs[d[:7]] = yrs.get(d[:7], 0) + x
        print(f"{mode}: by month at $10K", {m: f"{v / 1e3:+,.0f}K" for m, v in sorted(yrs.items())})


if __name__ == "__main__":
    main()
