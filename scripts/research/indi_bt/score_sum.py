"""V2 score rules vs V1, overnight hold, delta 0.15, 1% of the current account from $100,000.

  python3 score_sum.py      (from the repo root; after score_round.py)
"""
import csv, glob, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
RUNS = [("v1", "w_flat_n100", "V1: t ≥ 2 and day volume ≥ 1.5×"),
        ("t3r1", "s_t3r1", "t ≥ 3, volume ≥ 1×"), ("t25r12", "s_t25r12", "t ≥ 2.5, volume ≥ 1.2×"),
        ("t15r25", "s_t15r25", "t ≥ 1.5, volume ≥ 2.5×"),
        ("s20", "s_s20", "score ≥ 2.0"), ("s25", "s_s25", "score ≥ 2.5"), ("s30", "s_s30", "score ≥ 3.0"),
        ("m20", "s_m20", "moving volume blend ≥ 2.0"), ("m25", "s_m25", "moving volume blend ≥ 2.5"),
        ("b20", "s_b20", "speeding-up boost ≥ 2.0"), ("b25", "s_b25", "speeding-up boost ≥ 2.5"),
        ("t2or5x3", "s_t2or5x3", "V1, or t ≥ 2 with a 3× 5-min burst")]
LISTS = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]),
         ("151 unseen", lambda t: t["sym"] not in HIS40)]


def held(cost, steps):
    """What account() needs to book a trade the live bot's way, from its walk (sim.py steps (day, minute, side, share,
    price, rule) or "day,minute,side,share,price,rule;..." strings): dict(exit_day=the day of its last sale,
    marks={day: its return so far at that day's 15:50 carry price}). Spread it into the row: dict(..., **held(c, s))."""
    if isinstance(steps, str): steps = [x.split(",") for x in steps.split(";") if x]
    st_ = [(s_[0], int(s_[1]), s_[2], float(s_[3]), float(s_[4])) for s_ in steps]
    sells = [s_ for s_ in st_ if s_[2] == "sell"]
    exit_day = max((s_[0] for s_ in sells), default=st_[0][0] if st_ else None)
    marks = {}
    for d, m, side, q, px in st_:
        if side == "carry" and cost:
            got = sum(s_[3] * s_[4] for s_ in sells if s_[0] <= d)
            marks[d] = (got + q * px) / cost - 1
    return dict(exit_day=exit_day, marks=marks)


def account(T, pct=0.01):
    """pct of the account a trade, from $100,000; a row's pnl is its result at $10K. A day's trades are sized on the
    account as that day starts: closed trades plus the open ones marked at their last 15:50 carry price (the live bot
    sizes on its account value). A row with `exit_day` (see held()) joins the account at the end of that day, and its
    `marks` count in the drop while it is held (the audit of 2026-10-31: the whole result used to join on the entry
    day). A row without `exit_day` joins at once, as before: its figures run 1-4% high when trades are held overnight."""
    if not any(isinstance(t, dict) and t.get("exit_day") for t in T):
        eq, cur, start, peak, dd = 1e5, None, 1e5, 1e5, 0.0
        for t in T:
            if t["date"] != cur:
                cur = t["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
            eq += pct * start * max(-1, float(t["pnl"]) / 1e4)
        return eq, max(dd, 1 - eq / max(peak, eq))
    import collections
    by = collections.defaultdict(list)
    for t in T: by[t["date"]].append(t)
    days = sorted(set(by) | {t.get("exit_day") or t["date"] for t in T})
    eq, peak, dd, open_, prev = 1e5, 1e5, 0.0, [], None
    for d in days:
        base = eq + sum(stake * (t.get("marks") or {}).get(prev, 0.0) for stake, t in open_)
        for t in by.get(d, []): open_.append((pct * base, t))
        keep = []
        for stake, t in open_:
            if (t.get("exit_day") or t["date"]) == d: eq += stake * max(-1, float(t["pnl"]) / 1e4)
            else: keep.append((stake, t))
        open_ = keep
        now = eq + sum(stake * (t.get("marks") or {}).get(d, 0.0) for stake, t in open_)
        peak = max(peak, now); dd = max(dd, 1 - now / peak); prev = d
    return eq + sum(stake * max(-1, float(t["pnl"]) / 1e4) for stake, t in open_), dd


def main():
    for lname, lf in LISTS:
        print(f"\n### {lname}\n")
        print("| Rule | Signals | Trades | 2024 (n, per trade) | 2025 | 2026 | Without best 5 (24 / 25 / 26) | Win | Account at 1% | Worst drop |\n|---|---|---|---|---|---|---|---|---|---|")
        for key, p, lab in RUNS:
            A = [t for f in glob.glob(f"{B}/{p}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if lf(t)]
            T = sorted((t for t in A if t["status"] == "ok"), key=lambda t: (t["date"], int(t["minute"])))
            if not T: continue
            yr = {y: sorted(float(t["pnl"]) for t in T if t["date"][:4] == y) for y in ("2024", "2025", "2026")}
            eq, dd = account(T)
            pnl = [float(t["pnl"]) for t in T]
            print(f"| {lab} | {len(A)} | {len(T)} | " + " | ".join(f"{len(v)}, {st.fmean(v):+,.0f}" for v in yr.values())
                  + " | " + " / ".join(f"{sum(v[:-5]) / 1e3:+,.0f}K" for v in yr.values())
                  + f" | {100 * sum(x > 0 for x in pnl) / len(pnl):.0f}% | ${eq:,.0f} | {100 * dd:.0f}% |")


if __name__ == "__main__":
    main()
