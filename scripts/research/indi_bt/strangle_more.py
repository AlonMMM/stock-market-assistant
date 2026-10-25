"""V2: more strangle tests (the user, 2026-10-25), on the final rule's trades (zero9.py export), same contracts and
fill model (bar middle +/- 2% a leg, commission per contract):

  base         the export's rule replayed (a check: it must give the export's returns)
  D2           at the side, a second unit of the kept leg with new money (instead of recycling the wrong leg's money)
  leg_at_side  no strangle: at the minute the side is confirmed (0.25 S30 from the stock at the alert's fill), buy only
               that leg with the pair's premium; trail 30% on its closes, out by 15:30; no side within 60 min: no trade
  stock_trail  the strangle (with the recycle), but the kept leg is sold when the stock gives back K S30 (0.5 / 1 / 1.5)
               from its best since the side, instead of the option's 30% trail
And the market at the alert: SPY's move since the open and over the last 30 minutes (falling SPY), and breadth (how
many of the list's stocks alert within +/- 2 minutes).

  python3 strangle_more.py <trades.csv> [label]       (BT_UNIVERSE as the export's list)
"""
import collections, csv, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar
from levels import ctx
from rvol_alert import alerts_for
from strangle_filters import account, SPAN

K, WAIT, TRAIL, END = 0.25, 60, 0.30, 360
if os.environ.get("BT_SH"): sim.SH = float(os.environ["BT_SH"])   # a harsher fill, e.g. 0.04
CAL = calendar()


def path_of(r):
    """The pair's minute path from the fill, as zero9: (t, closes, mids, stock)."""
    date, m = r["date"], int(r["minute"])
    legs = {"C": r["call"], "P": r["put"]}
    bars = {k: {b[0]: b for b in day(c, date)} for k, c in legs.items()}
    sb = {b[0]: b for b in day(r["sym"], date)}
    last, fill_t, path = {}, None, []
    for t in range(m + 1, END + 1):
        for k in legs:
            if t in bars[k]: last[k] = bars[k][t]
        if len(last) < 2: continue
        if fill_t is None:
            if t > m + 3: return None
            fill_t = t; fill_mid = {k: sim.mid(last[k]) for k in legs}; continue
        path.append((t, {k: last[k][4] for k in legs}, {k: sim.mid(last[k]) for k in legs}, sb[t][4] if t in sb else None))
    return (fill_t, fill_mid, path, bars, sb) if fill_t else None


def run(r, x):
    got = path_of(r)
    if not got: return None
    fill_t, fill_mid, path, bars, sb = got
    m = int(r["minute"]); u = x["sd"]
    stock0 = sb[fill_t][4] if fill_t in sb else float(r["stock_at_fill"])
    SH, COMM = sim.SH, sim.COMM
    paid = {k: fill_mid[k] * (1 + SH) for k in "CP"}; cost0 = sum(paid.values())
    sell = lambda mid: max(mid * (1 - SH), 0.01)
    conf = None
    for t, closes, mids, spot in path:
        if t - m > WAIT: break
        if spot is None: continue
        mv = spot / stock0 - 1
        if abs(mv) >= K * u: conf = (t, "C" if mv > 0 else "P"); break
    out = {}
    if conf is None:
        row = next((p for p in path if p[0] - m >= WAIT), path[-1])
        r0 = sum(sell(row[2][k]) for k in "CP") / cost0 - 1 - COMM * 4 / (cost0 * 100)
        for v in ("base", "D2", "st0.25", "st0.5", "st0.75", "st1", "st1.5"): out[v] = r0
        out["leg_at_side"] = out["leg_st0.5"] = out["leg_st0.75"] = None
        return out
    ct, keep = conf; wrong = "P" if keep == "C" else "C"
    crow = next(p for p in path if p[0] == ct)
    sw = sell(crow[2][wrong]); add_px = crow[2][keep] * (1 + SH)
    after = [p for p in path if p[0] > ct]

    def exit_by(trail_opt, stock_k, units, cost, cash, nfills):
        peak = crow[1][keep]; best = crow[3] or stock0
        for t, closes, mids, spot in after:
            c = closes[keep]; peak = max(peak, c)
            if spot: best = max(best, spot) if keep == "C" else min(best, spot)
            done = t >= END
            if trail_opt and c <= peak * (1 - TRAIL): done = True
            if stock_k and spot and abs(spot / best - 1) >= stock_k * u: done = True
            if done: return (cash + units * sell(mids[keep])) / cost - 1 - COMM * nfills / (cost * 100)
        t, closes, mids, spot = path[-1]
        return (cash + units * sell(mids[keep])) / cost - 1 - COMM * nfills / (cost * 100)

    out["base"] = exit_by(True, None, 1 + sw / add_px, cost0, 0.0, 6)
    out["D2"] = exit_by(True, None, 2.0, cost0 + add_px, sw, 6)
    for k in (0.25, 0.5, 0.75, 1, 1.5): out[f"st{k}"] = exit_by(False, k, 1 + sw / add_px, cost0, 0.0, 6)
    # One leg at the side, with the pair's premium: the return on that premium.
    kb = bars[keep]; b0 = next((kb[q] for q in range(ct, ct + 4) if q in kb), None)
    if b0:
        cost = sim.mid(b0) * (1 + SH); peak = b0[4]; last = b0; ret = None
        for t in range(b0[0] + 1, END + 1):
            if t in kb: last = kb[t]
            c = last[4]; peak = max(peak, c)
            if t >= END or c <= peak * (1 - TRAIL): ret = sell(sim.mid(last)) / cost - 1 - COMM * 2 / (cost * 100); break
        out["leg_at_side"] = ret if ret is not None else sell(sim.mid(last)) / cost - 1 - COMM * 2 / (cost * 100)
        # the same leg, out when the stock gives back k S30 from its best since the side
        for k in (0.5, 0.75):
            last = b0; best = crow[3] or stock0; ret = None
            for t in range(b0[0] + 1, END + 1):
                if t in kb: last = kb[t]
                spot = sb[t][4] if t in sb else None
                if spot: best = max(best, spot) if keep == "C" else min(best, spot)
                if t >= END or (spot and abs(spot / best - 1) >= k * u):
                    ret = sell(sim.mid(last)) / cost - 1 - COMM * 2 / (cost * 100); break
            out[f"leg_st{k}"] = ret if ret is not None else sell(sim.mid(last)) / cost - 1 - COMM * 2 / (cost * 100)
    else:
        out["leg_at_side"] = out["leg_st0.5"] = out["leg_st0.75"] = None
    return out


def spy_moves(date, m):
    sb = {b[0]: b for b in day("SPY", date)}
    o = next((sb[k][1] for k in range(0, 5) if k in sb), None)
    c = next((sb[k][4] for k in range(m, m - 5, -1) if k in sb), None)
    c30 = next((sb[k][4] for k in range(m - 30, m - 35, -1) if k in sb), None)
    if not (o and c and c30): return None, None
    return (c / o - 1) * 100, (c / c30 - 1) * 100


def line(lab, rows, key):
    R = sorted(([t["date"], t["minute"], t[key]] for t in rows if t.get(key) is not None), key=lambda q: (q[0], q[1]))
    if not R: return f"| {lab} | 0 | | | | | |"
    R = [dict(date=d, minute=mm, ret=rr) for d, mm, rr in R]
    pn = [1e4 * max(-1, r["ret"]) for r in R]
    yr = {y: [1e4 * max(-1, r["ret"]) for r in R if r["date"][:4] == y] for y in SPAN}
    e1, d1 = account(R)
    best = set(sorted(range(len(R)), key=lambda i: -pn[i])[:5])
    e5, _ = account([r for i, r in enumerate(R) if i not in best])
    return (f"| {lab} | {len(R)} | {100 * sum(p > 0 for p in pn) / len(pn):.0f}% | {st.fmean(pn):+,.0f} | "
            + " / ".join(f"{st.fmean(v):+,.0f}" if v else "—" for v in yr.values()) + f" | ${e5:,.0f} | ${e1:,.0f}, {100 * d1:.0f}% |")


def main():
    path = sys.argv[1]; label = sys.argv[2] if len(sys.argv) > 2 else path
    rows = list(csv.DictReader(open(path)))
    # breadth: every alert of the list on the trade days
    dates = sorted({r["date"] for r in rows}); allal = collections.defaultdict(list)
    for sym in P["universe"]:
        for d in dates:
            if d not in CAL or CAL.index(d) < 21: continue
            al = alerts_for(sym, d, CAL)
            if al:
                for q, a in enumerate(al):
                    if a: allal[d].append((sym, q))
    T, diff = [], 0
    for r in rows:
        x = ctx(r["sym"], r["date"])
        if not x: continue
        res = run(r, x)
        if not res: continue
        if abs(res["base"] - float(r["ret"])) > 0.002: diff += 1
        m = int(r["minute"])
        so, s30 = spy_moves(r["date"], m)
        T.append(dict(date=r["date"], minute=m, sym=r["sym"], up=r["alert"] == "up", spy_open=so, spy_30=s30,
                      breadth=len({s for s, q in allal[r["date"]] if s != r["sym"] and abs(q - m) <= 2}), **res))
    head = "| {} | Trades | Winners | Per trade | 2024 / 2025 / 2026 | Without best 5 | At 1% |\n|---|---|---|---|---|---|---|"
    print(f"\n## {label}: {len(T)} trades (the replay differs from the export on {diff})\n")
    print(head.format("Variant"))
    print(line("the strangle, D (as now)", T, "base"))
    print(line("D2: a second unit of the kept leg, new money", T, "D2"))
    print(line("no strangle: only the leg, bought at the side", T, "leg_at_side"))
    for k in (0.25, 0.5, 0.75, 1, 1.5): print(line(f"the strangle, kept leg out when the stock gives back {k} S30", T, f"st{k}"))
    for k in (0.5, 0.75): print(line(f"only the leg at the side, out when the stock gives back {k} S30", T, f"leg_st{k}"))
    print("\n" + head.format("The market at the alert (the strangle, as now)"))
    groups = [
        ("SPY down 0.5%+ since the open", lambda t: t["spy_open"] is not None and t["spy_open"] <= -0.5),
        ("SPY down 0.25-0.5% since the open", lambda t: t["spy_open"] is not None and -0.5 < t["spy_open"] <= -0.25),
        ("SPY within ±0.25% of the open", lambda t: t["spy_open"] is not None and abs(t["spy_open"]) < 0.25),
        ("SPY up 0.25%+ since the open", lambda t: t["spy_open"] is not None and t["spy_open"] >= 0.25),
        ("SPY down 0.3%+ in the last 30 min", lambda t: t["spy_30"] is not None and t["spy_30"] <= -0.3),
        ("SPY down 0.3%+ in 30 min and 3+ stocks alerting", lambda t: t["spy_30"] is not None and t["spy_30"] <= -0.3 and t["breadth"] >= 3),
        ("3+ other stocks alerting (any SPY)", lambda t: t["breadth"] >= 3),
        ("a down alert while SPY falls 0.3%+ in 30 min", lambda t: t["spy_30"] is not None and t["spy_30"] <= -0.3 and not t["up"]),
    ]
    for lab, f in groups: print(line(lab, [t for t in T if f(t)], "base"))
    print(line("**skip: SPY down 0.3%+ in the last 30 min**", [t for t in T if not (t["spy_30"] is not None and t["spy_30"] <= -0.3)], "base"))
    print(line("**skip: SPY down 0.5%+ since the open**", [t for t in T if not (t["spy_open"] is not None and t["spy_open"] <= -0.5)], "base"))


if __name__ == "__main__":
    main()
