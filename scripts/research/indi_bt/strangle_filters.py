"""V2: two false-alarm ideas for the alert strangle (the user, 2026-10-25), on the trades of the final rule
(zero9.py export: 0.35 delta, confirm 0.25 S30, the D bonus, trail 30%).

  1. bounce   the alert comes right after the stock failed at a level: in the W minutes before the alert (15 / 30) its
              high came within 0.25 S30 of a resistance above (or its low of a support below) without a close 0.25 S30
              beyond it, and the alert points away from that level (down after failing at resistance, up after support).
              Levels as levels.py: yesterday's and the 5-day high / low, the first 15 minutes' range, the day's
              extremes before the window.
  2. against  the stock made a big move first and the alert is the other way: the move from the open (or the last 60
              minutes) to the alert, in S30 units, at least K (1.5 / 2 / 3) one way, and the alert the other.

Each as a tag (the tagged trades against the rest) and as an entry filter (skip the tagged alerts).

  python3 strangle_filters.py <trades.csv> [label]     (from the repo root)
"""
import csv, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from levels import ctx

NEAR, BEYOND = 0.25, 0.25
SPAN = ("2024", "2025", "2026")


def levels_before(x, start):
    """Levels known when the window starts (the day's extremes before it)."""
    L = {"yesterday": (x["prev_hi"], x["prev_lo"]), "5-day": (x["p5_hi"], x["p5_lo"])}
    hs = [v for v in x["h"][:start] if v]; ls = [v for v in x["l"][:start] if v]
    if hs: L["day so far"] = (max(hs), min(ls))
    if start >= 15 and any(x["h"][:15]):
        L["first 15 min"] = (max(v for v in x["h"][:15] if v), min(v for v in x["l"][:15] if v))
    return L


def failed_at(x, m, w):
    """-> ('resistance' | 'support', level name) for a failed test in [m-w, m-1], or None. The latest one wins."""
    start = max(1, m - w)
    u = x["sd"]
    found = None
    for name, (hi, lo) in levels_before(x, start).items():
        for kind, lvl, sign in (("resistance", hi, 1), ("support", lo, -1)):
            touched, broke = None, False
            for k in range(start, m):
                c, h, l = x["c"][k], x["h"][k], x["l"][k]
                if c is None: continue
                p = c
                if sign * (c - lvl) >= BEYOND * u * p: broke = True; break
                edge = h if sign > 0 else l
                if sign * (lvl - edge) <= NEAR * u * p: touched = k
            if touched is not None and not broke and (found is None or touched > found[2]):
                found = (kind, name, touched)
    return found[:2] if found else None


def big_move(x, m, frm):
    """The stock's move from minute `frm` to the alert, in S30 units (signed), or None."""
    a, b = next((x["c"][k] for k in range(frm, m) if x["c"][k]), None), x["c"][m]
    if not a or not b: return None
    return (b / a - 1) / x["sd"]


def account(T, pct=0.01):
    eq, cur, start, peak, dd = 1e5, None, 1e5, 1e5, 0.0
    for t in T:
        if t["date"] != cur: cur = t["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        eq += pct * start * max(-1, t["ret"])
    return eq, max(dd, 1 - eq / max(peak, eq))


def line(lab, T):
    if not T: return f"| {lab} | 0 | | | | | |"
    T = sorted(T, key=lambda t: (t["date"], t["minute"]))
    pn = [t["pnl"] for t in T]
    yr = {y: [t["pnl"] for t in T if t["date"][:4] == y] for y in SPAN}
    e1, d1 = account(T)
    best = set(sorted(range(len(T)), key=lambda i: -pn[i])[:5])
    e5, _ = account([t for i, t in enumerate(T) if i not in best])
    return (f"| {lab} | {len(T)} | {100 * sum(p > 0 for p in pn) / len(pn):.0f}% | {st.fmean(pn):+,.0f} | "
            + " / ".join(f"{st.fmean(v):+,.0f}" if v else "—" for v in yr.values()) + f" | ${e5:,.0f} | ${e1:,.0f}, {100 * d1:.0f}% |")


def main():
    path = sys.argv[1]; label = sys.argv[2] if len(sys.argv) > 2 else path
    T = []
    for r in csv.DictReader(open(path)):
        x = ctx(r["sym"], r["date"])
        if not x: continue
        m = int(r["minute"]); up = r["alert"] == "up"
        t = dict(date=r["date"], sym=r["sym"], minute=m, ret=float(r["ret"]), pnl=float(r["pnl10k"]), up=up)
        for w in (15, 30):
            f = failed_at(x, m, w)
            t[f"bounce{w}"] = bool(f and ((f[0] == "resistance" and not up) or (f[0] == "support" and up)))
            t[f"failtest{w}"] = bool(f)                      # any failed test, either alert side
            t[f"bounce{w}_kind"] = f[1] if f else ""
        mo = big_move(x, m, 0); mh = big_move(x, m, max(0, m - 60))
        t["move_open"], t["move_hour"] = mo, mh
        for k in (1.5, 2, 3):
            t[f"against_open{k}"] = mo is not None and abs(mo) >= k and (mo > 0) != up
            t[f"against_hour{k}"] = mh is not None and abs(mh) >= k and (mh > 0) != up
            t[f"with_open{k}"] = mo is not None and abs(mo) >= k and (mo > 0) == up
        T.append(t)
    head = "| {} | Trades | Winners | Per trade | 2024 / 2025 / 2026 | Without best 5 | At 1% |\n|---|---|---|---|---|---|---|"
    print(f"\n## {label}: {len(T)} trades\n")
    print(head.format("Group")); print(line("all trades", T))
    print("\n### 1. The alert right after a failed test of a level (a bounce)\n"); print(head.format("Group"))
    for w in (15, 30):
        print(line(f"bounce, {w} min: alert away from the level it failed at", [t for t in T if t[f"bounce{w}"]]))
        print(line(f"  failed test, alert toward the level", [t for t in T if t[f"failtest{w}"] and not t[f"bounce{w}"]]))
        print(line(f"  no failed test in {w} min", [t for t in T if not t[f"failtest{w}"]]))
        print(line(f"**skip the bounces ({w} min)**", [t for t in T if not t[f"bounce{w}"]]))
    kinds = sorted({t["bounce30_kind"] for t in T if t["bounce30"]})
    for k in kinds: print(line(f"  bounce 30 min at {k}", [t for t in T if t["bounce30"] and t["bounce30_kind"] == k]))
    print("\n### 2. A big move first, then the alert the other way\n"); print(head.format("Group"))
    for k in (1.5, 2, 3):
        print(line(f"from the open ≥ {k} S30, alert against", [t for t in T if t[f"against_open{k}"]]))
        print(line(f"  from the open ≥ {k} S30, alert with it", [t for t in T if t[f"with_open{k}"]]))
        print(line(f"**skip: from the open ≥ {k}, against**", [t for t in T if not t[f"against_open{k}"]]))
    for k in (1.5, 2, 3):
        print(line(f"last 60 min ≥ {k} S30, alert against", [t for t in T if t[f"against_hour{k}"]]))
        print(line(f"**skip: last 60 min ≥ {k}, against**", [t for t in T if not t[f"against_hour{k}"]]))
    print("\n### Both\n"); print(head.format("Group"))
    print(line("**skip bounces (30) and against-the-open (2)**", [t for t in T if not t["bounce30"] and not t["against_open2"]]))


if __name__ == "__main__":
    main()
