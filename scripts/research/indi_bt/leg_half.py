"""The Alert leg, half out at a big gain, the rest with more air (the user, 2026-10-25: "at 200% selling 50% only if
did not sell with back, the rest give more air"). On the page's trades (the one-leg export, trades.csv): the same
buy; while the stock has not given back 0.75 S30 from its best, the first minute the option's sale price (bar middle
- 2%) is TARGET above the buy, half the contracts are sold there; the rest is sold when the stock gives back G2 S30
from its best (G2 wider than 0.75), or at 15:30. Trades that never reach TARGET are unchanged. Whole contracts from
1% / 2% of each morning's account from $100,000, at the +/-2% and +/-4% fills.

  python3 leg_half.py <trades.csv>
"""
import csv, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day

SH, COMM, END, GIVE = 0.02, 0.62, 360, 0.75


def walk(t, target, g2):
    """-> list of (share, sale price) for the leg, from the export's buy."""
    sym, date, side = t["sym"], t["date"], "C" if t["kept"] == "call" else "P"
    u = float(t["sd30"]) / 100
    kb = {b[0]: b for b in day(t["leg"], date)}
    sb = {b[0]: b for b in day(sym, date)}
    buy, b0 = float(t["buy_price"]), int(t["buy_minute"])
    sm = int(t["side_minute"])
    best = sb[sm][4] if sm in sb else float(t["stock_at_fill"])
    last = kb.get(b0); half = None; give = GIVE
    for q in range(b0 + 1, END + 1):
        if q in kb: last = kb[q]
        spot = sb[q][4] if q in sb else None
        if spot: best = max(best, spot) if side == "C" else min(best, spot)
        px = max(sim.mid(last) * (1 - SH), 0.01) if last else None
        if q >= END or (spot and abs(spot / best - 1) >= give * u):
            return ([(0.5, half), (0.5, px)] if half else [(1.0, px)]), q
        if target and half is None and px and px / buy - 1 >= target:
            half = px; give = g2
    return ([(0.5, half), (0.5, px)] if half else [(1.0, px)]), END


def account(T, size, fill):
    eq, cur, start, rows = 1e5, None, 1e5, []
    for t in sorted(T, key=lambda t: (t["date"], int(t["minute"]))):
        if t["date"] != cur: cur, start = t["date"], eq
        buy = t["buy"] if fill == 2 else t["buy"] / 1.02 * 1.04
        q = int(size / 100 * start // (buy * 100))
        if q < 1: continue
        parts = t["parts"]
        if len(parts) == 2:
            q1 = q // 2 if q > 1 else q
            sells = [(q1, parts[0][1]), (q - q1, parts[1][1])]
        else: sells = [(q, parts[0][1])]
        got = sum(n * (p if fill == 2 else p / 0.98 * 0.96) for n, p in sells)
        pnl = (got - q * buy) * 100 - COMM * 2 * q
        eq += pnl; rows.append(dict(t, pnl=pnl, account=eq))
    peak, dd = 1e5, 0.0
    for r in rows: peak = max(peak, r["account"]); dd = max(dd, 1 - r["account"] / peak)
    return eq, dd, rows


def main():
    rows = [r for r in csv.DictReader(open(sys.argv[1])) if r["buy_price"] and r["exit_price"]]
    lists = {"Indi's stocks (fair)": [r for r in rows if r["list"] == "fair"],
             "Favorites, 12 months": [r for r in rows if r["list"] == "fav"],
             "Favorites, last 2 months": [r for r in rows if r["list"] == "fav" and r["date"] >= "2026-08-24"]}
    variants = [("as now (all out at 0.75)", None, None)]
    for tg in (1.0, 2.0, 3.0):
        for g2 in (1.0, 1.5, 2.0, 99):
            variants.append((f"half at +{tg * 100:.0f}%, rest at {'15:30 only' if g2 == 99 else f'{g2} S30'}", tg, g2))
    for name, R in lists.items():
        print(f"\n## {name}\n\n| Rule | Halves sold | 1%, ±2%: end, worst drop | without best 5 | 1%, ±4% | 2%, ±2% | biggest trade |")
        print("|---|---|---|---|---|---|---|")
        chk = 0
        for lab, tg, g2 in variants:
            T = []
            for r in R:
                parts, q = walk(r, tg, g2)
                if tg is None and abs(parts[0][1] - float(r["exit_price"])) > 0.002: chk += 1
                T.append(dict(date=r["date"], minute=r["minute"], sym=r["sym"], buy=float(r["buy_price"]), parts=parts))
            e1, d1, X = account(T, 1, 2)
            top = {(x["date"], x["sym"]) for x in sorted(X, key=lambda x: -x["pnl"])[:5]}
            e5, _, _ = account([t for t in T if (t["date"], t["sym"]) not in top], 1, 2)
            e4, d4, _ = account(T, 1, 4); e2, d2, _ = account(T, 2, 2)
            big = max(X, key=lambda x: x["pnl"])
            print(f"| {lab} | {sum(len(t['parts']) == 2 for t in T)} | ${e1:,.0f}, {100 * d1:.1f}% | ${e5:,.0f} | ${e4:,.0f}, {100 * d4:.1f}% | ${e2:,.0f}, {100 * d2:.1f}% | {big['sym']} {big['date']} {big['pnl']:+,.0f} |")
        print(f"\n(the replay of 'as now' differs from the export's sale on {chk} trades)")


if __name__ == "__main__":
    main()
