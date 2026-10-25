"""V2: no strangle when the alert breaks a level (the user, 2026-10-25: "when we break support or resistance - no need
strangle"). On the final rule's trades (zero9.py export): an alert that breaks a level is one whose close is 0.25 S30
beyond a level (yesterday's or the 5-day high / low, the first 15 minutes' range, the day's extremes before the
window) in the alert's direction, while the close before the 3-minute window was not. For those, the direction is
taken as known: buy only the leg the alert points to (same contract, same fill model: bar middle +/- 2%), and run it
as the kept leg (trail 30% off its high, out by 15:30), with or without a -30% stop; the same premium as the pair.

  python3 strangle_break.py <trades.csv> [label]
"""
import csv, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day
from levels import ctx
from strangle_filters import levels_before, account, SPAN

BEYOND = 0.25


def broke(x, m, up):
    """The level the alert broke in its direction, or None."""
    u = x["sd"]; c, c0 = x["c"][m], x["c"][m - 3] if m >= 3 else None
    if not c or not c0: return None
    for name, (hi, lo) in levels_before(x, m - 3).items():
        lvl, sign = (hi, 1) if up else (lo, -1)
        if sign * (c - lvl) >= BEYOND * u * c and sign * (c0 - lvl) < BEYOND * u * c0: return name
    return None


def single(contract, date, fill_m, stop):
    """One leg bought at the fill minute's bar middle + 2%, trailed 30% on closes, out by 15:30. -> return."""
    bars = {b[0]: b for b in day(contract, date)}
    b0 = next((bars[k] for k in range(fill_m, fill_m + 4) if k in bars), None)
    if not b0: return None
    cost = sim.mid(b0) * (1 + sim.SH); peak = b0[4]; last = b0
    for t in range(b0[0] + 1, 361):
        if t in bars: last = bars[t]
        c = last[4]; peak = max(peak, c)
        if t >= 360 or c <= peak * 0.7 or (stop and c <= cost * 0.7):
            return max(sim.mid(last) * (1 - sim.SH), 0.01) / cost - 1 - sim.COMM * 2 / (cost * 100)
    return max(sim.mid(last) * (1 - sim.SH), 0.01) / cost - 1 - sim.COMM * 2 / (cost * 100)


def line(lab, T, key):
    if not T: return f"| {lab} | 0 | | | | | |"
    T = sorted(T, key=lambda t: (t["date"], t["minute"]))
    R = [dict(date=t["date"], minute=t["minute"], ret=t[key]) for t in T]
    pn = [1e4 * max(-1, r["ret"]) for r in R]
    yr = {y: [1e4 * max(-1, r["ret"]) for r in R if r["date"][:4] == y] for y in SPAN}
    e1, d1 = account(R)
    best = set(sorted(range(len(R)), key=lambda i: -pn[i])[:5])
    e5, _ = account([r for i, r in enumerate(R) if i not in best])
    return (f"| {lab} | {len(R)} | {100 * sum(p > 0 for p in pn) / len(pn):.0f}% | {st.fmean(pn):+,.0f} | "
            + " / ".join(f"{st.fmean(v):+,.0f}" if v else "—" for v in yr.values()) + f" | ${e5:,.0f} | ${e1:,.0f}, {100 * d1:.0f}% |")


def main():
    path = sys.argv[1]; label = sys.argv[2] if len(sys.argv) > 2 else path
    T = []
    for r in csv.DictReader(open(path)):
        x = ctx(r["sym"], r["date"])
        if not x: continue
        m = int(r["minute"]); up = r["alert"] == "up"
        t = dict(date=r["date"], sym=r["sym"], minute=m, strangle=float(r["ret"]), up=up, kept=r["kept"])
        t["broke"] = broke(x, m, up)
        if t["broke"]:
            leg = r["call"] if up else r["put"]
            t["single"] = single(leg, r["date"], int(r["fill_minute"]), False)
            t["single_stop"] = single(leg, r["date"], int(r["fill_minute"]), True)
            if t["single"] is None: t["broke"] = None
        T.append(t)
    head = "| {} | Trades | Winners | Per trade | 2024 / 2025 / 2026 | Without best 5 | At 1% |\n|---|---|---|---|---|---|---|"
    B = [t for t in T if t["broke"]]; N = [t for t in T if not t["broke"]]
    print(f"\n## {label}: {len(T)} trades, {len(B)} alerts broke a level in their direction "
          f"({', '.join(f'{k} {sum(1 for t in B if t["broke"] == k)}' for k in sorted({t['broke'] for t in B}))}); "
          f"the strangle kept the alert's side on {sum(1 for t in B if (t['kept'] == 'call') == t['up'] and t['kept'])} of them\n")
    print(head.format("On the alerts that broke a level"))
    print(line("the strangle (as now)", B, "strangle"))
    print(line("only the leg the alert points to, trail 30%", B, "single"))
    print(line("  the same with a −30% stop", B, "single_stop"))
    print(line("(the other alerts, the strangle)", N, "strangle"))
    for t in T:
        t["mix"] = t["single"] if t["broke"] else t["strangle"]
        t["mix_stop"] = t["single_stop"] if t["broke"] else t["strangle"]
    print("\n" + head.format("Every trade"))
    print(line("the strangle on every alert (as now)", T, "strangle"))
    print(line("**a break: the one leg; else the strangle**", T, "mix"))
    print(line("  the same, the one leg with a −30% stop", T, "mix_stop"))


if __name__ == "__main__":
    main()
