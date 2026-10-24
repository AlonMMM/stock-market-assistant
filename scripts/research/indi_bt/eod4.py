"""V2: the close trade held longer the next day (the user, 2026-10-24: "what about stay with the position and sell after
in some strategy?"). The same entries as eod3.py (the day's strength >= 1.5 / 2.0, top 20% of the range, 1-4 days out,
delta 0.15 / 0.20 / 0.25; read from eod3_trades.csv), new exits the next session, set before running (a rule decides on
a bar's close and sells on the next bar at the middle - 2%):
  M30     all at 10:00 (eod3's best, for reference)
  HOLD    out at -30%, else all at 15:50
  TP100   all at +100% or -30%, else all at 15:50
  TRAIL   out at -30%; once up +50%, out 30% under the highest close since the open; else all at 15:50
  USTOP   the champion's stop on the stock: at 09:40 and 09:50 (10 / 20 minutes after the open) half / the rest when the
          stock is against yesterday's 15:55 price; -30% with the stock against; else all at 15:50
On the fair list and the 151 unseen (the Favorites year as a re-test). 1% of the start-of-day account from $100,000.

  python3 eod4.py      (from the repo root, after eod3.py)
"""
import csv, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, calendar
from score_sum import account

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
M, EOD = 385, 380
EXITS = ("M30", "HOLD", "TP100", "TRAIL", "USTOP")
SH = sim.SH


def exits(r):
    cost = float(r["cost"]); nxt = CAL[IDX[r["date"]] + 1]; bet = 1 if r["right"] == "C" else -1
    ob = day(r["contract"], nxt)
    if not ob: return None
    s0 = next((b[4] for b in reversed(day(r["sym"], r["date"])) if b[0] <= M), None)
    sc = {b[0]: b[4] for b in day(r["sym"], nxt)}
    stock = lambda m: next((sc[j] for j in range(m, -1, -1) if j in sc), s0)
    sell = lambda b: max(sim.mid(b) * (1 - SH), 0.01)
    after = lambda m: next((b for b in ob if b[0] > m), ob[-1])
    at = lambda m: next((b for b in ob if b[0] >= m), ob[-1])
    res = {"M30": [(1.0, sell(at(30)))]}
    for name in ("HOLD", "TP100", "TRAIL"):
        peak, out = cost, None
        for b in ob:
            if b[0] >= EOD: break
            c = b[4]; peak = max(peak, c)
            if c <= cost * 0.7: out = b; break
            if name == "TP100" and c >= cost * 2: out = b; break
            if name == "TRAIL" and peak >= cost * 1.5 and c <= peak * 0.7: out = b; break
        res[name] = [(1.0, sell(after(out[0]) if out else at(EOD)))]
    sales, rem = [], 1.0
    for m, share in ((10, 0.5), (20, 1.0)):
        if rem > 0 and bet * (stock(m) - s0) < 0:
            q = rem * share if share < 1 else rem
            sales.append((q, sell(after(m)))); rem -= q
    if rem > 0:
        out = next((b for b in ob if b[0] > 20 and b[0] < EOD and b[4] <= cost * 0.7 and bet * (stock(b[0]) - s0) < 0), None)
        sales.append((rem, sell(after(out[0]) if out else at(EOD))))
    res["USTOP"] = sales
    return {k: sim.result(cost, [(nxt, 0, "sell", q, p, k) for q, p in v]) for k, v in res.items()}


def main():
    rows = [r for r in csv.DictReader(open(f"{B}/eod3_trades.csv")) if r["kind"] == "day" and r["floor"] in ("1.5", "2.0")]
    out = []
    for r in rows:
        e = exits(r)
        if e: out.append(dict(r, **{f"x_{k}": v for k, v in e.items()}))
    for lname in ("fair", "unseen", "favorites"):
        print(f"\n### {lname} (trades / winners / per trade at $10K 2024 2025 2026 / account at 1% / worst drop / without best 5)")
        for floor in ("1.5", "2.0"):
            for d in ("0.15", "0.2", "0.25"):
                L = sorted((r for r in out if r["list"] == lname and r["floor"] == floor and r["delta"] == d), key=lambda r: r["date"])
                if not L: continue
                for ex in EXITS:
                    pn = [dict(date=r["date"], pnl=str(1e4 * max(-1, r[f"x_{ex}"]))) for r in L]
                    a1, d1 = account(pn)
                    top = set(sorted(range(len(pn)), key=lambda k: -float(pn[k]["pnl"]))[:5])
                    a5, _ = account([p for k, p in enumerate(pn) if k not in top])
                    win = sum(r[f"x_{ex}"] > 0 for r in L) / len(L)
                    yr = " ".join(f"{st.fmean([float(p['pnl']) for p in pn if p['date'][:4] == y] or [0]):+,.0f}" for y in ("2024", "2025", "2026"))
                    print(f"day t{floor} d{d} {ex:5} | {len(L)} / {100 * win:.0f}% / {yr} / ${a1:,.0f} / {100 * d1:.0f}% / wo5 ${a5:,.0f}")


if __name__ == "__main__":
    main()
