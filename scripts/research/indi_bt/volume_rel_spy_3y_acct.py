"""Scores the 3-year twin runs of volume_rel_spy_3y.py (leg_seconds.py STR_DUMP_DIR dumps, "shock <= 30%, burst >= 0",
the dashboard's flat account): 1.1.0 (today's code), + K 4, + K 6; 2% and 3%, tune (even ISO weeks) / check (odd),
without the best 5, by year, without 10-10, and the trades each version adds (not in 1.1.0's account).
  python3 volume_rel_spy_3y_acct.py <dir with base/ k4/ k6/>"""
import json, os, sys
from datetime import date as D
d = sys.argv[1]
net = lambda b, s: (s * 100 - 0.62) / (b * 100 + 0.62) - 1
half = lambda x: "tune" if D.fromisoformat(x).isocalendar()[1] % 2 == 0 else "check"
key = lambda t: (t["date"], t["sym"], t["minute"], t["side"])
K = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1e3:.1f}K"


def load(v, size, wo):
    mid = "without_2025_10_10_" if wo else ""
    return sorted(json.load(open(f"{d}/{v}/flat{size}_{mid}shock_30_burst_0.json")), key=lambda t: (t["date"], t["minute"]))


def stats(T):
    eq, peak, dd = 1e5, 1e5, 0.0
    h = {"tune": 0.0, "check": 0.0}; yr = {}
    for t in T:
        eq += t["pnl"]; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        h[half(t["date"])] += t["pnl"]; yr[t["date"][:4]] = yr.get(t["date"][:4], 0) + t["pnl"]
    p = sorted((t["pnl"] for t in T), reverse=True)
    return eq, dd, h, sum(p[5:]), yr


base = {key(t) for t in load("base", 2, False)}
for wo in (False, True):
    print("\n" + ("without 10 Oct 2025" if wo else "all days"))
    for v, name in (("base", "1.1.0 (today's code)"), ("k4", "+ stock/SPY >= 4"), ("k6", "+ stock/SPY >= 6")):
        T = load(v, 2, wo); e, dd, h, w5, yr = stats(T)
        e3, dd3, h3, _, _ = stats(load(v, 3, wo))
        print(f"  {name:22s} {len(T):3d}t 2%: ${e / 1e3:6.1f}K drop {100 * dd:4.1f}% tune {K(h['tune']):>8} check {K(h['check']):>8} w/o5 {K(w5):>8} "
              f"| {' '.join(f'{y} {K(x)}' for y, x in sorted(yr.items()))} | 3%: ${e3 / 1e3:6.1f}K drop {100 * dd3:4.1f}% tune {K(h3['tune'])} check {K(h3['check'])}")
        if v != "base" and not wo:
            add = [t for t in T if key(t) not in base]
            gone = len(base - {key(t) for t in T})
            r = sorted(net(t["buy"], t["sell"]) for t in add)
            if r:
                print(f"     added {len(add)} (1.1.0 trades pushed out by the limits: {gone}): median {100 * r[len(r) // 2]:+.0f}%, won {sum(x > 0 for x in r)}, "
                      f"+300% {sum(x >= 3 for x in r)}, flat $2K {K(2000 * sum(r))}; by half: " +
                      ", ".join(f"{hh} {sum(half(t['date']) == hh for t in add)}" for hh in ("tune", "check")) +
                      "; best: " + ", ".join(f"{t['sym']} {t['date']} {100 * net(t['buy'], t['sell']):+.0f}%" for t in sorted(add, key=lambda t: -net(t['buy'], t['sell']))[:5]))
