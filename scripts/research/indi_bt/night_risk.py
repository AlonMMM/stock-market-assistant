"""V2: less overnight risk for the least cost, on the champion (t >= 1.8, news filter, delta 0.15, your stop + hold
winners up >= +100% at 15:50). Each trade is walked again and split at the 15:50 hold (night_rules.parts); what is
not kept is sold at 15:50 (next bar's middle - 2%), the kept part follows the same night.

  keep x       hold only x of the winner
  free         sell at 15:50 just enough to get the trade's cost back; hold the rest ("house money")
  free half    the same for half the cost
  gain >= g    hold only winners up g or more (the others are sold)
  tiered       up 100-200%: hold half; up 200%+: hold all
  cap          at most this share of the account goes into the night (as in the bot)

Worst night: the biggest loss of the held parts on one night, from their 15:50 value, as a share of the account.

  python3 night_risk.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import news_filter as nf
from night_rules import parts
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
RULES = [("champion: hold every winner up 100%+", ("none", 0)), ("keep 75%", ("keep", 0.75)), ("keep 50%", ("keep", 0.5)),
         ("free: get the cost back, hold the rest", ("free", 1.0)), ("free half: half the cost back", ("free", 0.5)),
         ("hold only up 150%+", ("gain", 1.5)), ("hold only up 200%+", ("gain", 2.0)),
         ("tiered: 100-200% half, 200%+ all", ("tier", 2.0)),
         ("cap 10% of the account (the bot)", ("cap", 0.10)), ("cap 15%", ("cap", 0.15)),
         ("free + cap 10%", ("free_cap", 0.10))]


def kept(p, rule, pct, eq):
    """Contracts (per contract bought) held into the night under a rule."""
    kind, x = rule
    held, g = p["held"], p["cp"] / p["cost"] - 1
    if kind == "keep": held *= x
    if kind in ("free", "free_cap"):
        need = max(0.0, (x if kind == "free" else 1.0) * p["cost"] - p["before"])
        held = max(0.0, held - need / p["sell_px"])
    if kind == "gain" and g < x: held = 0.0
    if kind == "tier" and g < x: held *= 0.5
    if kind in ("cap", "free_cap"):
        cap = x
        worth = pct * eq * held * p["cp"] / p["cost"]
        if worth > cap * eq: held *= cap * eq / worth
    return held


def run(P, rule, pct):
    eq, cur, start, peak, dd = 1e5, None, 1e5, 1e5, 0.0
    night = {}
    for p in P:
        if p["date"] != cur:
            cur = p["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        r = p["ret"]
        if p["carried"]:
            h = kept(p, rule, pct, start)
            r = (p["before"] + (p["held"] - h) * p["sell_px"] + h * p["night"]) / p["cost"] - 1
            night[p["date"]] = night.get(p["date"], 0.0) + pct * start * h * (p["night"] - p["cp"]) / p["cost"] / start
        eq += pct * start * max(-1, r)
    return eq, max(dd, 1 - eq / max(peak, eq)), min(night.values(), default=0.0), sum(v for v in night.values() if v < 0)


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    with mp.Pool(6) as pool: P = sorted((p for p in pool.map(parts, T, chunksize=20) if p), key=lambda p: (p["date"], p["minute"]))
    for lname, lf in (("fair list", lambda p: p["sym"] in HIS40 and p["sym"] in PRIOR[p["date"][:4]]), ("151 unseen", lambda p: p["sym"] not in HIS40)):
        L = [p for p in P if lf(p)]
        print(f"\n### {lname}: {len(L)} trades, {sum(p['carried'] for p in L)} held overnight\n")
        print("| Night rule | At 1%: end / drop / worst night | At 2%: end / drop / worst night / all night losses |\n|---|---|---|")
        for lab, rule in RULES:
            a1, d1, w1, _ = run(L, rule, 0.01); a2, d2, w2, s2 = run(L, rule, 0.02)
            print(f"| {lab} | ${a1:,.0f} / {100 * d1:.0f}% / {100 * w1:.1f}% | ${a2:,.0f} / {100 * d2:.0f}% / {100 * w2:.1f}% / {100 * s2:.0f}% |", flush=True)


if __name__ == "__main__":
    main()
