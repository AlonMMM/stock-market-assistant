"""V2: sell at a failed break, buy back on the second try (the user's idea, 2026-10-23; levels from levels.py).

On the entry day, while held: the stock reaches the next level ahead (within 0.25 S30), then closes 0.5 S30 back
from it within 30 minutes without breaking it -> a failed break. Versions, set before running:
  all            sell everything held at the failed break (next bar's middle - 2%)
  half           sell half of what is held there; the rest keeps the champion's rules
  all + rebuy    all, then if the stock closes 0.25 S30 beyond the same level by 15:44, buy the same contract again
                 (same size as a new trade) and run it as a new entry with the champion's exits
  half + rebuy   half, then buy back a half-size trade on the second try
Once per trade. The half version's kept part follows the champion's sales, which are all shares of what is left, so
its result is half the champion's plus half the sale. 1% / 2% of the start-of-day account from $100,000.

  python3 fail_rebuy.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import day, calendar
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account, held
from levels import ctx, ahead, NEAR, BREAK, BACK, WAIT, EOD

B = "data/local/x/bt"
CAL = calendar()
X0 = {**sim.X, **H, **NIGHT}
LAST_BUY = 374  # 15:44, the signal window's end
VERSIONS = ("Champion", "all", "half", "all + rebuy", "half + rebuy")


def walk(t):
    bet = 1 if t["right"] == "C" else -1
    m0 = int(t["minute"])
    sim.X.clear(); sim.X.update(X0)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], t["contract"], t["expiry"], CAL)
    if cost is None: return None
    ret = sim.result(cost, steps)
    out = dict(key=(t["date"], t["sym"], t["minute"]), ret=ret, cf=None, rebuy=None, rebuy_min=None,
               h=held(cost, steps))
    x = ctx(t["sym"], t["date"])
    a = ahead(x, m0, bet) if x and x["c"][m0] is not None else None
    if not a: return out
    lv, sd0 = a[1], x["sd"] * x["c"][m0]
    carried = any(s[2] == "carry" for s in steps)
    last = max((s[1] for s in steps if s[2] == "sell" and s[0] == t["date"]), default=EOD)
    end = EOD if carried else min(EOD, last)
    touch = fail = None
    for m in range(m0 + 1, end):
        p = x["c"][m]
        if p is None: continue
        d = bet * (lv - p) / sd0
        if d <= -BREAK: break
        if d <= NEAR and touch is None: touch = m
        if touch is not None and m - touch > WAIT: break
        if touch is not None and d >= BACK: fail = m; break
    if fail is None: return out
    nxt = next((b for b in day(t["contract"], t["date"]) if b[0] > fail), None)
    if not nxt: return out
    before = [s for s in steps if s[2] == "sell" and (s[0], s[1]) <= (t["date"], fail)]
    sold = sum(s[3] * s[4] for s in before); rem = 1 - sum(s[3] for s in before)
    out["cf"] = (sold + rem * sim.mid(nxt) * (1 - sim.SH)) / cost - 1
    for m in range(nxt[0] + 1, LAST_BUY + 1):  # the second try
        p = x["c"][m]
        if p is not None and bet * (p - lv) / sd0 >= BREAK:
            sim.X.clear(); sim.X.update(X0)
            c2, s2, _ = sim.walk(t["sym"], t["date"], m, t["right"], t["contract"], t["expiry"], CAL)
            if c2 is not None: out["rebuy"], out["rebuy_min"], out["rebuy_h"] = sim.result(c2, s2), m, held(c2, s2)
            break
    return out


def rows_for(t, r, v):
    """-> account rows (pnl at $10K) for version v of one trade; a rebuy is a second row the same day."""
    base = dict(date=t["date"], sym=t["sym"])
    pt = lambda x: str(1e4 * max(-1, x))
    if v == "Champion" or r["cf"] is None: return [dict(base, pnl=pt(r["ret"]), **r["h"])]
    half = v.startswith("half")
    first = 0.5 * r["cf"] + 0.5 * r["ret"] if half else r["cf"]
    out = [dict(base, pnl=pt(first))]
    if half:  # the kept half rides the champion's walk; the sold half is cf
        out[0].update(exit_day=r["h"]["exit_day"], marks={d: 0.5 * r["cf"] + 0.5 * x for d, x in r["h"]["marks"].items()})
    if v.endswith("rebuy") and r["rebuy"] is not None:
        k = 0.5 if half else 1
        h = dict(r["rebuy_h"], marks={d: k * x for d, x in r["rebuy_h"]["marks"].items()})
        out.append(dict(base, pnl=str(1e4 * max(-1, r["rebuy"]) * k), **h))
    return out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = {r["key"]: r for r in pool.map(walk, T, chunksize=10) if r}
    key = lambda t: (t["date"], t["sym"], t["minute"])
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and key(t) in R]
        F = [t for t in L if R[key(t)]["cf"] is not None]
        RB = [t for t in F if R[key(t)]["rebuy"] is not None]
        print(f"\n### {lname}: {len(L)} trades, {len(F)} failed breaks, {len(RB)} second tries bought back "
              f"(those {sum(R[key(t)]['rebuy'] > 0 for t in RB)} winners, sum {sum(1e4 * max(-1, R[key(t)]['rebuy']) for t in RB) / 1e3:+,.0f}K at $10K)\n")
        print("| Version | Per trade 2024 / 2025 / 2026 (P&L at $10K) | Without the best 5 | At 1% | At 2% |\n|---|---|---|---|---|")
        for v in VERSIONS:
            rows = [x for t in L for x in rows_for(t, R[key(t)], v)]
            yr = [sum(float(x["pnl"]) for x in rows if x["date"][:4] == y) / max(1, sum(t["date"][:4] == y for t in L)) for y in ("2024", "2025", "2026")]
            wo = sorted(float(x["pnl"]) for x in rows)[:-5]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            print(f"| {v} | " + " / ".join(f"{y:+,.0f}" for y in yr) + f" | {sum(wo) / len(L):+,.0f} a trade | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |", flush=True)
        for v in ("Champion", "all", "half"):  # equal risk: the size that gives the champion's worst drop at 1% / 2%
            rows = [x for t in L for x in rows_for(t, R[key(t)], v)]
            print(f"  {v} by size: " + ", ".join(f"{p:.2%} ${account(rows, p)[0]:,.0f} / {100 * account(rows, p)[1]:.0f}%" for p in (0.01, 0.0125, 0.02, 0.025)))
        big = sorted(RB, key=lambda t: -R[key(t)]["rebuy"])[:5]
        print("\nbest second tries:", [(t["sym"], t["date"], f"{100 * R[key(t)]['rebuy']:+.0f}%", f"champion {100 * R[key(t)]['ret']:+.0f}%") for t in big])
        for s in ("BA", "ORCL"):
            for t in F:
                if t["sym"] == s and R[key(t)]["ret"] > 5:
                    r = R[key(t)]
                    print(f"{s} {t['date']}: champion {100 * r['ret']:+.0f}%, sold at the fail {100 * r['cf']:+.0f}%, second try "
                          + ("none" if r["rebuy"] is None else f"{100 * r['rebuy']:+.0f}% (bought at minute {r['rebuy_min']})"))


if __name__ == "__main__":
    main()
