"""V2: the end-of-day entry for tomorrow. A stock that beat SPY x beta all day and in the last half hour, and did
not sell off into the close, is bought at 15:46 New York (22:46 Israel) and held overnight. Volume is not used.

Per stock-day at minute 376 (15:46), in the direction of the day's strength:
  t_day   the C t-stat of 1-minute moves vs SPY x beta, 09:31-15:46
  t30     the same t-stat over the last 30 minutes only (15:16-15:46)
  ex30    the move vs SPY x beta over the last 30 minutes, %
  ex_day  the move vs SPY x beta since yesterday's close, %
  give    how far the price is from the day's high (low for a put), % (0 = at the high)
  rp      position in the day's range (1 = at the high)
  gap     the stock's move from 15:46 to the next open, in the bet direction, % (the answer, not an input)

  python3 eod2.py features            -> data/local/x/bt/eod2_features.csv (191 stocks, BT_UNIVERSE=wide)
  python3 eod2.py profile             -> his end-of-day entries vs every stock-day, and the stock-only rule test
  python3 eod2.py signals <rule>      -> data/local/x/bt/e2_sig_<rule>_<year>.csv (sim.py format)
"""
import csv, collections, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta

B = "data/local/x/bt"
M = 376
FEAT = f"{B}/eod2_features.csv"
SPAN = ("2024-02-01", "2026-10-12")


def tstat(xs):
    if len(xs) < 5: return 0.0
    sd = st.pstdev(xs)
    return st.fmean(xs) / sd * math.sqrt(len(xs)) if sd else 0.0


def stock(sym):
    cal = calendar(); out = []
    for i, d in enumerate(cal):
        if not (SPAN[0] <= d <= SPAN[1]) or i < 21 or i >= len(cal) - 1: continue
        bars, pb, nb = day(sym, d), day(sym, cal[i - 1]), day(sym, cal[i + 1])
        if len(bars) <= 300 or not pb or not nb: continue
        b_ = beta(sym, d, i, cal)
        if b_ is None: continue
        c, h, l, _ = series(bars); spy = series(day("SPY", d))[0]; spb = day("SPY", cal[i - 1])
        if not c[M] or not spy[M] or not spb: continue
        steps = [(c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1) for m in range(1, M + 1) if c[m] and c[m - 1] and spy[m] and spy[m - 1]]
        t = tstat(steps)
        bet = 1 if t >= 0 else -1
        last = [bet * x for x in steps[-30:]]
        pc = pb[-1][4]
        ex = lambda a, sa: bet * ((c[M] / a - 1) - b_ * (spy[M] / sa - 1)) * 100
        hi = max(x for x in h[:M + 1] if x); lo = min(x for x in l[:M + 1] if x)
        give = (hi / c[M] - 1) * 100 if bet > 0 else (c[M] / lo - 1) * 100
        rp = ((c[M] - lo) if bet > 0 else (hi - c[M])) / (hi - lo) if hi > lo else 0.0
        out.append(dict(date=d, sym=sym, right="C" if bet > 0 else "P", price=c[M], t_day=round(abs(t), 2), t30=round(tstat(last), 2),
                        ex30=round(ex(c[M - 30], spy[M - 30]), 2) if c[M - 30] and spy[M - 30] else "",
                        ex_day=round(ex(pc, spb[-1][4]), 2), give=round(give, 2), rp=round(rp, 2),
                        fri=int(__import__("datetime").date.fromisoformat(d).weekday() == 4),
                        gap=round(bet * (nb[0][1] / c[M] - 1) * 100, 3)))
    return out


def features():
    with mp.Pool(8) as pool: parts = pool.map(stock, P["universe"])
    rows = sorted((r for p in parts for r in p), key=lambda r: (r["date"], r["sym"]))
    with open(FEAT, "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(len(rows), "stock-days ->", FEAT)


def load():
    R = list(csv.DictReader(open(FEAT)))
    for r in R:
        for k in ("t_day", "t30", "ex_day", "give", "rp", "gap"): r[k] = float(r[k])
        r["ex30"] = float(r["ex30"]) if r["ex30"] != "" else 0.0
    return R


def his_eod():
    """His end-of-day entries (e_sig_hiseod): (date, sym) -> right."""
    out = {}
    for y in ("2024", "2025", "2026"):
        f = f"{B}/e_sig_hiseod_{y}.csv"
        if os.path.exists(f):
            for r in csv.DictReader(open(f)): out[(r["date"], r["sym"])] = r["right"]
    return out


# Rules on the features at 15:46 (volume-free). top: keep only the best N a day by t_day.
RULES = {
    "a": (lambda r: r["t_day"] >= 2 and r["ex30"] > 0 and r["rp"] >= 0.8, None),
    "b": (lambda r: r["t_day"] >= 2 and r["t30"] >= 1 and r["rp"] >= 0.9, None),
    "c": (lambda r: r["t_day"] >= 3 and r["ex30"] > 0 and r["rp"] >= 0.8, None),
    "d": (lambda r: r["t_day"] >= 2 and r["ex30"] > 0 and r["give"] <= 0.5, None),
    "e": (lambda r: r["t_day"] >= 2 and r["t30"] >= 1 and r["give"] <= 0.5, None),
    "a2": (lambda r: r["t_day"] >= 2 and r["ex30"] > 0 and r["rp"] >= 0.8, 2),
    "c2": (lambda r: r["t_day"] >= 3 and r["ex30"] > 0 and r["rp"] >= 0.8, 2),
    "e2": (lambda r: r["t_day"] >= 2 and r["t30"] >= 1 and r["give"] <= 0.5, 2),
    # his profile: a big day vs SPY x beta, near the high, still beating SPY in the last half hour
    "f": (lambda r: r["ex_day"] >= 3 and r["rp"] >= 0.85 and r["ex30"] > 0, None),
    "g": (lambda r: r["ex_day"] >= 2 and r["t_day"] >= 1 and r["rp"] >= 0.85 and r["give"] <= 0.5, None),
    "h": (lambda r: 2 <= r["ex_day"] <= 6 and r["t_day"] >= 1 and r["rp"] >= 0.85 and r["ex30"] > 0, None),
    "f2": (lambda r: r["ex_day"] >= 3 and r["rp"] >= 0.85 and r["ex30"] > 0, 2),
    "g2": (lambda r: r["ex_day"] >= 2 and r["t_day"] >= 1 and r["rp"] >= 0.85 and r["give"] <= 0.5, 2),
    "h2": (lambda r: 2 <= r["ex_day"] <= 6 and r["t_day"] >= 1 and r["rp"] >= 0.85 and r["ex30"] > 0, 2),
}
RANK = {"f2": "ex_day", "g2": "ex_day", "h2": "ex_day"}  # the rest rank by t_day


def pick(R, rule, his40_only=False):
    f, top = RULES[rule]
    by = collections.defaultdict(list)
    for r in R:
        if f(r): by[r["date"]].append(r)
    out = []
    for d, v in by.items():
        v.sort(key=lambda r: -r[RANK.get(rule, "t_day")])
        out += v[:top] if top else v
    return out


def profile():
    from low_delta import HIS40, PRIOR
    R = load(); H = his_eod()
    his = [r for r in R if (r["date"], r["sym"]) in H and H[(r["date"], r["sym"])] == r["right"]]
    base = [r for r in R if r["sym"] in HIS40]
    print(f"His end-of-day entries found with the same direction: {len(his)} of {len(H)}\n")
    print("| Feature | His entries: p25 / median / p75 | Every stock-day of the 40: p25 / median / p75 |\n|---|---|---|")
    q = lambda v: " / ".join(f"{x:.2f}" for x in st.quantiles(v, n=4))
    for k in ("t_day", "t30", "ex30", "ex_day", "give", "rp"):
        print(f"| {k} | {q([r[k] for r in his])} | {q([r[k] for r in base])} |")
    print(f"| next open, our way % | {q([r['gap'] for r in his])} | {q([r['gap'] for r in base])} |")
    lists = [("fair list", lambda r: r["sym"] in HIS40 and r["sym"] in PRIOR[r["date"][:4]]), ("151 unseen", lambda r: r["sym"] not in HIS40)]
    print("\nStock only, 15:46 to the next open, in the bet direction (no options yet):\n")
    print("| Rule | List | Signals | Per day | Gap our way: 2024 / 2025 / 2026 (mean %) | Up share |\n|---|---|---|---|---|---|")
    for rule in RULES:
        for lname, lf in lists:
            S = [r for r in pick(R, rule) if lf(r)]
            if not S: continue
            yr = [[r["gap"] for r in S if r["date"][:4] == y] for y in ("2024", "2025", "2026")]
            days = len({r["date"] for r in S})
            print(f"| {rule} | {lname} | {len(S)} | {len(S) / max(days, 1):.1f} | " + " / ".join(f"{st.fmean(v):+.2f}" if v else "" for v in yr)
                  + f" | {100 * sum(r['gap'] > 0 for r in S) / len(S):.0f}% |")
    for lname, lf in lists:
        b = [r for r in R if lf(r)]
        yr = [[r["gap"] for r in b if r["date"][:4] == y] for y in ("2024", "2025", "2026")]
        print(f"| every stock-day | {lname} | {len(b)} | | " + " / ".join(f"{st.fmean(v):+.2f}" for v in yr) + f" | {100 * sum(r['gap'] > 0 for r in b) / len(b):.0f}% |")
    hy = [[r["gap"] for r in his if r["date"][:4] == y] for y in ("2024", "2025", "2026")]
    print(f"| his end-of-day entries | 40 | {len(his)} | | " + " / ".join(f"{st.fmean(v):+.2f}" if v else "" for v in hy) + f" | {100 * sum(r['gap'] > 0 for r in his) / len(his):.0f}% |")


def signals(rule):
    R = load()
    for y in ("2024", "2025", "2026"):
        S = sorted((r for r in pick(R, rule) if r["date"][:4] == y), key=lambda r: (r["date"], r["sym"]))
        with open(f"{B}/e2_sig_{rule}_{y}.csv", "w") as f:
            w = csv.DictWriter(f, fieldnames=["date", "sym", "right", "minute", "time", "price", "t_day", "t30", "ex30", "give", "rp"])
            w.writeheader()
            for r in S: w.writerow(dict(date=r["date"], sym=r["sym"], right=r["right"], minute=M, time="15:46", price=r["price"],
                                        t_day=r["t_day"], t30=r["t30"], ex30=r["ex30"], give=r["give"], rp=r["rp"]))
        print(rule, y, len(S))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "features": features()
    elif cmd == "profile": profile()
    elif cmd == "signals": signals(sys.argv[2])
