"""V2: safer overnight holds on the champion (C signal, your stop + hold winners up >= +100% at 15:50).

Each trade is walked again with the champion's exits, then the night is changed after the fact:
  drop5 / drop10   no hold when the option's 15:50 close is X% or more under its highest close of the last 5 (10)
                   minutes; those contracts are sold at 15:50 like any other (next bar's middle - 2%)
  cap              at most this share of the account goes into the night: what the held contracts are worth above it
                   is sold at 15:50; the rest follows the same night (the morning rules sell shares of what is left,
                   so the kept part's result scales)
Account at 1% and 2% of the current account from $100,000, on the fair list and the 151 unseen stocks.

  python3 night_rules.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
CAL = calendar()
SH = sim.SH
EOD = sim.X["eod_minute"]


def parts(t):
    """-> the trade split at the 15:50 hold, or None when it was not held."""
    sim.X.update(dict(H, **NIGHT))
    sym = t["contract"]; exp = t["expiry"]
    cost, steps, flag = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], sym, exp, CAL)
    if cost is None: return None
    carry = next((s for s in steps if s[2] == "carry"), None)
    out = dict(date=t["date"], sym=t["sym"], minute=int(t["minute"]), cost=cost, ret=sim.result(cost, steps), carried=carry is not None)
    if not carry: return out
    d = carry[0]
    before = sum(s[3] * s[4] for s in steps if s[2] == "sell" and s[0] == d)
    held, cp = carry[3], carry[4]
    night = sum(s[3] * s[4] for s in steps if s[2] == "sell" and s[0] > d) / held  # per contract held, sold later
    bars = day(sym, d)
    last = [b[4] for b in bars if EOD - 10 < b[0] <= EOD]
    last5 = [b[4] for b in bars if EOD - 5 < b[0] <= EOD]
    nxt = next((b for b in bars if b[0] > EOD), None)
    sell_px = (nxt[2] + nxt[3]) / 2 * (1 - SH) if nxt else cp * (1 - SH)
    out.update(before=before, held=held, cp=cp, night=night, sell_px=sell_px,
               drop5=cp / max(last5) - 1 if last5 else 0.0, drop10=cp / max(last) - 1 if last else 0.0)
    return out


def load(prefix):
    T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    with mp.Pool(6) as pool: P = [p for p in pool.map(parts, T, chunksize=20) if p]
    return sorted(P, key=lambda p: (p["date"], p["minute"]))


def result(p, rule, pct, eq):
    """The trade's return on its cost under a night rule, at `pct` of an account worth `eq`."""
    if not p["carried"]: return p["ret"]
    kind, x = rule
    held = p["held"]
    if kind == "drop5" and p["drop5"] <= -x: held = 0.0
    if kind == "drop10" and p["drop10"] <= -x: held = 0.0
    if kind == "cap":
        worth = pct * eq * held * p["cp"] / p["cost"]  # dollars going into the night
        if worth > x * eq: held *= x * eq / worth
    sold = p["held"] - held
    return (p["before"] + sold * p["sell_px"] + held * p["night"]) / p["cost"] - 1


def account(P, rule, pct):
    eq, cur, start, peak, dd, nights = 1e5, None, 1e5, 1e5, 0.0, 0
    for p in P:
        if p["date"] != cur:
            cur = p["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        r = result(p, rule, pct, start)
        eq += pct * start * max(-1, r)
    return eq, max(dd, 1 - eq / max(peak, eq))


RULES = [("V1: hold every winner up 100%+", ("none", 0)),
         ("no hold after a 5-min drop >= 5%", ("drop5", 0.05)), ("no hold after a 5-min drop >= 10%", ("drop5", 0.10)),
         ("no hold after a 5-min drop >= 15%", ("drop5", 0.15)), ("no hold after a 10-min drop >= 10%", ("drop10", 0.10)),
         ("no hold after a 10-min drop >= 20%", ("drop10", 0.20)),
         ("night capped at 3% of the account", ("cap", 0.03)), ("night capped at 4%", ("cap", 0.04)),
         ("night capped at 5%", ("cap", 0.05))]


def main():
    sets = [("fair list, delta 0.15", "w_flat_n100", lambda p: p["sym"] in HIS40 and p["sym"] in PRIOR[p["date"][:4]]),
            ("fair list, delta 0.10", "t_flat_n100_d10", lambda p: p["sym"] in HIS40 and p["sym"] in PRIOR[p["date"][:4]]),
            ("151 unseen, delta 0.15", "w_flat_n100", lambda p: p["sym"] not in HIS40)]
    cache = {}
    for name, prefix, f in sets:
        if prefix not in cache: cache[prefix] = load(prefix)
        P = [p for p in cache[prefix] if f(p)]
        C = [p for p in P if p["carried"]]
        print(f"\n### {name}: {len(P)} trades, {len(C)} held overnight\n")
        print("| Night rule | Held | Night part: median / mean | At 1%: end / worst drop | At 2%: end / worst drop |\n|---|---|---|---|---|")
        for lab, rule in RULES:
            kept = [p for p in C if result(p, rule, 0.01, 1e5) != p["ret"] or rule[0] in ("none", "cap")]
            if rule[0] == "drop5": kept = [p for p in C if p["drop5"] > -rule[1]]
            if rule[0] == "drop10": kept = [p for p in C if p["drop10"] > -rule[1]]
            nights = [p["night"] / p["cp"] - 1 for p in kept]
            n = f"{st.median(nights):+.0%} / {st.fmean(nights):+.0%}" if nights else ""
            a1, d1 = account(P, rule, 0.01); a2, d2 = account(P, rule, 0.02)
            print(f"| {lab} | {len(kept)} | {n} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% |")


if __name__ == "__main__":
    main()
