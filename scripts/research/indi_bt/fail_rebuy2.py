"""V2: sell all at a failed break, buy back on the second try, the buy-back run as the original trade going on
(the user's idea, 2026-10-23; follows fail_rebuy.py, where the buy-back ran as a new entry and lost).

Failed break as in fail_rebuy.py (sell everything held, next bar's middle - 2%). The buy-back (same size as the
original, the same contract) when the stock closes 0.25 S30 beyond the same level by 15:44. Versions, set before running:
  new entry       the buy-back has the champion's exits: +10 / +20 minute checks, -30%, 15:50 hold (fail_rebuy.py)
  continuation    no +10 / +20 checks (the original trade had them already): -30% with the stock against the buy-back,
                  15:50 hold for +100%, morning gap rule
  continuation x3 the same, and after a buy-back is sold that day, buy back again on the next break (back under the
                  level first), at most 3 buy-backs
1% / 2% of the start-of-day account from $100,000; each buy-back is a trade row of its own.

  python3 fail_rebuy2.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, sys
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
XC = {**X0, "user_stop": {"checks": [], "out": -0.30}}
LAST_BUY = 374
VERSIONS = (("new entry", X0, 1), ("continuation", XC, 1), ("continuation x3", XC, 3))


def walk(t):
    bet = 1 if t["right"] == "C" else -1
    m0 = int(t["minute"])
    sim.X.clear(); sim.X.update(X0)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], t["contract"], t["expiry"], CAL)
    if cost is None: return None
    out = dict(key=(t["date"], t["sym"], t["minute"]), ret=sim.result(cost, steps), cf=None, rb={},
               h=held(cost, steps), rbh={})
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
    for lab, XV, tries in VERSIONS:
        res, hs, m, armed = [], [], nxt[0] + 1, True
        while m <= LAST_BUY and len(res) < tries:
            p = x["c"][m]
            if p is not None and not armed and bet * (lv - p) >= 0: armed = True  # back under the level first
            if p is not None and armed and bet * (p - lv) / sd0 >= BREAK:
                sim.X.clear(); sim.X.update(XV)
                c2, s2, _ = sim.walk(t["sym"], t["date"], m, t["right"], t["contract"], t["expiry"], CAL)
                if c2 is None: break
                res.append((m, sim.result(c2, s2))); hs.append(held(c2, s2))
                outs = [s for s in s2 if s[2] == "sell"]
                if any(s[2] == "carry" for s in s2) or not outs or outs[-1][0] != t["date"]: break
                m, armed = outs[-1][1] + 1, False
                continue
            m += 1
        out["rb"][lab], out["rbh"][lab] = res, hs
    return out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    with mp.Pool(6) as pool: R = {r["key"]: r for r in pool.map(walk, T, chunksize=10) if r}
    key = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: str(1e4 * max(-1, x))
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t) and key(t) in R]
        print(f"\n### {lname}: {len(L)} trades, {sum(R[key(t)]['cf'] is not None for t in L)} failed breaks\n")
        print("| Version | Buy-backs (winners), sum at $10K | Per trade 2024 / 2025 / 2026 | At 1% | At 2% |\n|---|---|---|---|---|")
        vers = [("Champion", None), ("Sell all, no buy-back", "none")] + [(f"Sell all + buy back, {lab}", lab) for lab, _, _ in VERSIONS]
        for name, v in vers:
            rows, rb = [], []
            for t in L:
                r = R[key(t)]; base = dict(date=t["date"], sym=t["sym"])
                if v is None or r["cf"] is None: rows.append(dict(base, pnl=pt(r["ret"]), **r["h"])); continue
                rows.append(dict(base, pnl=pt(r["cf"])))
                for (_, x), h in zip(r["rb"].get(v, []), r["rbh"].get(v, [])):
                    rows.append(dict(base, pnl=pt(x), **h)); rb.append(x)
            yr = [sum(float(x["pnl"]) for x in rows if x["date"][:4] == y) / max(1, sum(t["date"][:4] == y for t in L)) for y in ("2024", "2025", "2026")]
            a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
            rbt = f"{len(rb)} ({sum(x > 0 for x in rb)}), {sum(1e4 * max(-1, x) for x in rb) / 1e3:+,.0f}K" if rb else "-"
            print(f"| {name} | {rbt} | " + " / ".join(f"{y:+,.0f}" for y in yr) + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |", flush=True)
        for t in L:
            r = R[key(t)]
            if r["cf"] is not None and r["ret"] > 5:
                print(f"{t['sym']} {t['date']}: champion {100 * r['ret']:+.0f}%, sold at the fail {100 * r['cf']:+.0f}%; buy-backs " +
                      "; ".join(f"{lab}: " + (", ".join(f"{9 + (30 + m) // 60}:{(30 + m) % 60:02d} NY {100 * x:+.0f}%" for m, x in r["rb"].get(lab, [])) or "none") for lab, _, _ in VERSIONS))


if __name__ == "__main__":
    main()
