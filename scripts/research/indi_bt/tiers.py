"""C / B / A entries with adds and a roll (signals.py tiers -> one row per stock and day).

  C  conditions 1 + 2 (steady strength vs SPY x beta, volume since the open >= 1.5x)      0.5% risk
  B  C + one of 3 (15-min volume burst), 4 (at the day extreme), 5 (beyond yesterday)       1%
  A  all five                                                                               3%
A trade starts at the tier of its first minute. When the stock reaches a higher tier later the same
day, the position is topped up to that tier's size in the same contract, only if it is winning then
(option above the first entry's cost) and not yet sold. 1% risk = $10K of premium (fixed dollars).
Roll: when the first entry is up `roll.gain` (or, with `roll.near`, the stock is close to the strike) within
`roll.within` minutes, `roll.share` of it is sold and a new contract at delta BT_ROLL_DELTA (default 0.20) is bought
with half its profit so far (BT_ROLL_FUND=premium: with what the sold part cost); the rest is sold at +rest_take.
Exits for every part: params exit_variants["user"] style overrides from BT_EXIT (your stop, then 15:50).

  python3 tiers.py <signals_tiers.csv> <out prefix> [shard/shards]  -> <prefix>_legs.csv, <prefix>_trades.csv
"""
import csv, os, sys
import sim
from store import P, day, calendar, occ

V = P["entry_variants"]["tiers"]
RISK = dict(V["risk"])
if os.environ.get("BT_FLAT"): RISK = {"C": 0.01, "B": 0.01, "A": 0.01}  # baseline: every trade at 1%, no adds
UNIT = 10000 / 0.01  # dollars of premium per 1.0 of risk
ROLL_DELTA = float(os.environ.get("BT_ROLL_DELTA", "0.20"))
ROLL_FUND = os.environ.get("BT_ROLL_FUND", "profit")  # "profit": half the profit so far; "premium": the sold part's original cost


def leg(t, minute, sym, exp, cal):
    cost, steps, flag = sim.walk(t["sym"], t["date"], minute, t["right"], sym, exp, cal)
    if cost is None: return None
    return dict(cost=cost, steps=steps, ret=sim.result(cost, steps), flag=flag)


def open_and_winning(L, date, minute, sym):
    """The first leg is still held at `minute` (no full exit before) and its option is above cost."""
    sold = sum(s[3] for s in L["steps"] if s[2] == "sell" and (s[0], s[1]) < (date, minute))
    if sold >= 0.999: return False
    b = [x for x in day(sym, date) if x[0] <= minute]
    return bool(b) and b[-1][4] > L["cost"]


def run(rows, prefix, shard=0, shards=1):
    cal = calendar(); legs, trades = [], []
    for n, t in enumerate(rows):
        if n % shards != shard: continue
        m = int(t["minute"]); bm = int(t["b_minute"]) if t["b_minute"] != "" else None; am = int(t["a_minute"]) if t["a_minute"] != "" else None
        picked, why = sim.pick(t["sym"], t["date"], m, t["right"], float(t["price"]))
        if not picked: trades.append(dict(t, id=n, status=why)); continue
        sym, exp, k, dl, px, v30, iv = picked
        tier = "A" if am == m else "B" if bm == m else "C"
        base = leg(t, m, sym, exp, cal)
        if not base: trades.append(dict(t, id=n, status="no_fill")); continue
        L = [dict(kind="entry_" + tier, minute=m, contract=sym, premium=RISK[tier] * UNIT, **base)]
        size = RISK[tier]
        for nt, tm in (("B", bm), ("A", am)):
            if tm is None or tm <= m or RISK[nt] <= size: continue
            if not open_and_winning(base, t["date"], tm, sym): continue
            add = leg(t, tm, sym, exp, cal)
            if add:
                L.append(dict(kind="add_" + nt, minute=tm, contract=sym, premium=(RISK[nt] - size) * UNIT, **add)); size = RISK[nt]
        roll = next((s for s in base["steps"] if s[5] == "R_roll"), None)
        if roll:
            profit = L[0]["premium"] * (roll[4] / base["cost"] - 1)
            spot = [x for x in day(t["sym"], roll[0]) if x[0] <= roll[1]]
            if spot and profit > 0:
                old = sim.C["delta"]; sim.C["delta"] = ROLL_DELTA
                rp, _ = sim.pick(t["sym"], roll[0], roll[1], t["right"], spot[-1][4])
                sim.C["delta"] = old
                if rp:
                    saved = sim.X.pop("roll")  # the new contract does not roll again
                    rl = leg(dict(t, date=roll[0]), roll[1], rp[0], rp[1], cal)
                    sim.X["roll"] = saved
                    fund = 0.5 * profit
                    if ROLL_FUND == "premium": fund = L[0]["premium"] * roll[3]
                    if rl: L.append(dict(kind="roll", minute=roll[1], contract=rp[0], premium=fund, **rl))
        pnl = sum(l["premium"] * l["ret"] for l in L)
        prem = sum(l["premium"] for l in L)
        trades.append(dict(t, id=n, status="ok", contract=sym, expiry=exp, delta=round(dl, 3), iv=round(iv, 3) if iv else "",
                           start_tier=tier, top_tier="A" if size == RISK["A"] else "B" if size == RISK["B"] else "C",
                           legs=len(L), rolled=int(any(l["kind"] == "roll" for l in L)), premium=round(prem), pnl=round(pnl),
                           ret=round(pnl / prem, 4), first_ret=round(base["ret"], 4)))
        for i, l in enumerate(L):
            legs.append(dict(id=n, leg=i, kind=l["kind"], minute=l["minute"], contract=l["contract"], premium=round(l["premium"]),
                             cost=round(l["cost"], 4), ret=round(l["ret"], 4), rules="|".join(s[5] for s in l["steps"][1:])))
    out = f"{prefix}.{shard}" if shards > 1 else prefix
    for name, data in (("trades", trades), ("legs", legs)):
        if not data: continue
        with open(f"{out}_{name}.csv", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(dict.fromkeys(k for r in data for k in r))); w.writeheader(); w.writerows(data)
    print(len(trades), "stock-days,", sum(t["status"] == "ok" for t in trades), "traded ->", f"{out}_trades.csv")


if __name__ == "__main__":
    shard, shards = map(int, sys.argv[3].split("/")) if len(sys.argv) > 3 else (0, 1)
    run(list(csv.DictReader(open(sys.argv[1]))), sys.argv[2], shard, shards)
