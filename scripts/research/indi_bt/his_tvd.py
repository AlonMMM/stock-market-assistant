"""His entries by the bot's own measures (the user, 2026-10-30: "can you try to analyse the data from indi enters? gather
T V D2 from this stock - do a research and show me all the data").

Every opening trade of his main account (silexx, actions.csv 2023-10 to 2026-10; the first buy of each trade, his NY
time), on a stock or ETF we have 1-minute bars for (index options SPXW / NDXP / VIXW left out). At his entry minute,
bars up to and including it, on his side (a put is the mirror):
  t      the bot's t: the day's t-stat of the 1-minute excess moves (stock - beta x SPY) from the open (defence_signals.py)
  v      the bot's volume: the day's volume to that minute / its median to that minute over the 20 sessions before
  d2     the bot's D2: the excess on SPY-down minutes (a put: SPY-up) over the last 30 minutes, in the stock's S30 units
  d2max  the highest 30-minute D2 reached so far today          d2day  D2 from the open
  pos    where the price is in the day's range so far (1 = at the high, his way)
  move   from the day before's close; exday the same minus beta x SPY's; ex60 the last 60 minutes' excess; vwap above it
  spy    SPY from the day before's close, his way
  bot    the bot's champion entry (t >= 1.8 and v >= 1.5) holds at his minute; first = the first minute it held today
Peers: every stock of our lists (his 40 + the Favorites) at the same minute, same side: his stock's rank (100 = the
strongest) and how many peers pass t >= 1.8 and v >= 1.5. His result: the trade's realized P&L / the premium of all its
buys; held overnight; giant = 3x the premium or more.

  python3 his_tvd.py        (from the repo root) -> data/local/x/bt/his_tvd.csv + printed tables
"""
import collections, csv, glob, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import beta
from levels import ctx
import fav_real as FR

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
PEERS = sorted(set(P["universe"]) | FR.FAV)
SKIP = {"SPXW", "SPX", "NDXP", "VIXW"}
KEYS = ("t", "v", "d2", "d2max", "d2day", "pos", "move", "exday", "ex60", "vwap", "spy")


def trades():
    """One row per trade: the first buy (date, NY minute, contract) and the trade's result."""
    seen, by = set(), collections.defaultdict(list)
    for f in sorted(glob.glob("data/local/x/ultrawavetrader-20*/actions.csv")):
        for r in csv.DictReader(open(f)):
            k = (r["trade"], r["date"], r["time_from"], r["action"], r["qty"])
            if r["account"] != "silexx" or k in seen: continue
            seen.add(k); by[r["trade"]].append(r)
    out = []
    for tid, R in by.items():
        R.sort(key=lambda r: (r["date"], r["time_from"] or "99"))
        o = R[0]
        if o["action"] != "open" or not o["time_from"] or o["side"] != "B": continue
        und, exp, sr = o["contract"].rsplit(" ", 2)
        if und in SKIP or not sr[-1] in "CP": continue
        hh, mm = int(o["time_from"][:2]), int(o["time_from"][3:5])
        minute = hh * 60 + mm - 570
        if not 0 <= minute < 390: continue
        cost = sum(float(r["qty"]) * float(r["avg_price"]) * 100 for r in R if r["side"] == "B" and r["avg_price"])
        pnl = sum(float(r["realized_step"]) for r in R if r["realized_step"])
        out.append(dict(trade=tid, date=o["date"], sym=und, right=sr[-1], strike=float(sr[:-1]), exp=exp, minute=minute,
                        time=o["time_from"][:5], price=float(o["avg_price"]), qty=int(float(o["qty"])), cost=cost, pnl=pnl,
                        ret=pnl / cost if cost else 0.0, night=int(any(r["date"] > o["date"] for r in R)),
                        adds=sum(r["action"] in ("add", "re-enter") for r in R)))
    return out


def arrays(sym, date):
    """Per minute, both sides: the measures above, or None."""
    i = IDX.get(date)
    if i is None or i < 21: return None
    bars = day(sym, date); prev = day(sym, CAL[i - 1]); sb = day("SPY", date); sp = day("SPY", CAL[i - 1])
    if len(bars) < 300 or not prev or not sb or not sp: return None
    b_ = beta(sym, date, i, CAL); cx = ctx(sym, date)
    if b_ is None or not cx or not cx["sd"]: return None
    unit = cx["sd"]
    c, h, l, v = [None] * 390, [None] * 390, [None] * 390, [0] * 390
    for x in bars:
        if 0 <= x[0] < 390: c[x[0]], h[x[0]], l[x[0]], v[x[0]] = x[4], x[2], x[3], x[5]
    s = [None] * 390
    for x in sb:
        if 0 <= x[0] < 390: s[x[0]] = x[4]
    for arr in (c, s):
        for m in range(1, 390):
            if arr[m] is None: arr[m] = arr[m - 1]
    hist = []
    for d in CAL[i - 20:i]:
        cv = [0] * 390
        for x in day(sym, d):
            if 0 <= x[0] < 390: cv[x[0]] = x[5]
        acc = 0
        for m in range(390): acc += cv[m]; cv[m] = acc
        if acc: hist.append(cv)
    if len(hist) < 10: return None
    pc, spc = prev[-1][4], sp[-1][4]
    out = {"C": {}, "P": {}}
    n = s1 = s2 = 0.0; ec, ep = [0.0] * 390, [0.0] * 390
    hi = lo = None; pv = vol = 0.0; cum = 0
    for m in range(390):
        if c[m] is None or s[m] is None: continue
        if h[m] is not None:
            hi = h[m] if hi is None else max(hi, h[m]); lo = l[m] if lo is None else min(lo, l[m])
            pv += (h[m] + l[m] + c[m]) / 3 * v[m]
        vol += v[m]; cum += v[m]
        if m >= 1 and c[m - 1] and s[m - 1]:
            rs, rp = c[m] / c[m - 1] - 1, s[m] / s[m - 1] - 1
            x = rs - b_ * rp
            n += 1; s1 += x; s2 += x * x
            if rp < 0: ec[m] = x / unit
            if rp > 0: ep[m] = -x / unit
        med = sorted(hh[m] for hh in hist)[len(hist) // 2]
        if n < 5 or hi is None: continue
        mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
        t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
        pos = (c[m] - lo) / (hi - lo) if hi > lo else 0.5
        rv = cum / med if med else 0.0
        mv, sm = c[m] / pc - 1, s[m] / spc - 1
        k = next((j for j in range(max(0, m - 60), m + 1) if c[j] and s[j]), m)
        e60 = (c[m] / c[k] - 1) - b_ * (s[m] / s[k] - 1)
        vw = c[m] / (pv / vol) - 1 if vol and pv else 0.0
        for side, e, bet in (("C", ec, 1), ("P", ep, -1)):
            d2 = sum(e[max(1, m - 29):m + 1])
            out[side][m] = dict(t=bet * t, v=rv, d2=d2, d2day=sum(e[1:m + 1]), pos=pos if bet > 0 else 1 - pos,
                                move=bet * mv, exday=bet * (mv - b_ * sm), ex60=bet * e60, vwap=bet * vw, spy=bet * sm)
    for side in ("C", "P"):
        best, first = -9.0, None
        for m in sorted(out[side]):
            x = out[side][m]
            best = max(best, x["d2"]) if m >= 10 else best
            x["d2max"] = best
            if first is None and 10 <= m <= 374 and x["t"] >= 1.8 and x["v"] >= 1.5: first = m
            x["first"] = first
    return out


def one_day(job):
    date, T = job
    syms = sorted(set(PEERS) | {t["sym"] for t in T})
    A = {s: arrays(s, date) for s in syms}
    rows = []
    for t in T:
        a = A.get(t["sym"])
        if not a or t["minute"] not in a[t["right"]]: continue
        x = a[t["right"]][t["minute"]]
        peers = [A[s][t["right"]][t["minute"]] for s in PEERS if s != t["sym"] and A.get(s) and t["minute"] in A[s][t["right"]]]
        r = dict(t, **{k: x[k] for k in KEYS}, bot=int(x["t"] >= 1.8 and x["v"] >= 1.5 and 10 <= t["minute"] <= 374),
                 first="" if x["first"] is None else x["first"], npeers=len(peers),
                 peers_bot=sum(p["t"] >= 1.8 and p["v"] >= 1.5 for p in peers))
        for k in ("t", "v", "d2", "pos", "exday"):
            r[f"rk_{k}"] = round(100 * sum(p[k] < x[k] for p in peers) / len(peers)) if peers else ""
        px = c_at(t["sym"], date, t["minute"])
        r["otm"] = (t["strike"] / px - 1) * (1 if t["right"] == "C" else -1) if px else ""
        r["dte"] = (dt_(t["exp"]) - dt_(date)).days
        rows.append(r)
    return rows


def c_at(sym, date, m):
    xs = [x[4] for x in day(sym, date) if x[0] <= m]
    return xs[-1] if xs else None


def dt_(s):
    import datetime
    return datetime.date.fromisoformat(s)


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else float("nan")


def main():
    T = trades()
    print(len(T), "trades on stocks / ETFs", flush=True)
    by = collections.defaultdict(list)
    for t in T: by[t["date"]].append(t)
    with mp.Pool(8) as pool: rows = [r for R in pool.map(one_day, sorted(by.items()), chunksize=4) for r in R]
    rows.sort(key=lambda r: (r["date"], r["minute"]))
    cols = list(rows[0].keys())
    with open(f"{B}/his_tvd.csv", "w") as f:
        w = csv.DictWriter(f, cols); w.writeheader(); w.writerows(rows)
    print(len(rows), "with bars ->", f"{B}/his_tvd.csv")
    groups = (("all", lambda r: True), ("winners", lambda r: r["pnl"] > 0), ("losers", lambda r: r["pnl"] <= 0),
              ("giants (3x+)", lambda r: r["ret"] >= 3), ("held overnight", lambda r: r["night"]), ("same day", lambda r: not r["night"]),
              ("calls", lambda r: r["right"] == "C"), ("puts", lambda r: r["right"] == "P"),
              ("before 10:00", lambda r: r["minute"] < 30), ("10:00-15:00", lambda r: 30 <= r["minute"] < 330), ("15:00+", lambda r: r["minute"] >= 330))
    print("\n| Group | n | t p25 / med / p75 | v p25 / med / p75 | D2 p25 / med / p75 | D2 max | pos med | move med | rank t / v / D2 | bot rule holds | his P&L |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for g, f in groups:
        R = [r for r in rows if f(r)]
        if not R: continue
        p = lambda k: f"{q([r[k] for r in R], .25):.2f} / {q([r[k] for r in R], .5):.2f} / {q([r[k] for r in R], .75):.2f}"
        rk = lambda k: st.median(r[f"rk_{k}"] for r in R if r[f"rk_{k}"] != "")
        print(f"| {g} | {len(R)} | {p('t')} | {p('v')} | {p('d2')} | {q([r['d2max'] for r in R], .5):.2f} | {q([r['pos'] for r in R], .5):.2f} | "
              f"{q([r['move'] for r in R], .5):+.1%} | {rk('t'):.0f} / {rk('v'):.0f} / {rk('d2'):.0f} | {sum(r['bot'] for r in R) / len(R):.0%} | ${sum(r['pnl'] for r in R):+,.0f} |")
    print("\n#### The share of his entries over each level (and the same for all peers at his minutes)")
    print("| Rule | His entries | His P&L of those |\n|---|---|---|")
    for lab, f in (("t >= 1.8", lambda x: x["t"] >= 1.8), ("t >= 1.2", lambda x: x["t"] >= 1.2), ("t >= 0", lambda x: x["t"] >= 0),
                   ("v >= 1.5", lambda x: x["v"] >= 1.5), ("v >= 1.3", lambda x: x["v"] >= 1.3), ("D2 >= 0.5", lambda x: x["d2"] >= 0.5),
                   ("D2 >= 0", lambda x: x["d2"] >= 0), ("D2 max >= 0.5", lambda x: x["d2max"] >= 0.5),
                   ("t >= 1.8 and v >= 1.5 (bot)", lambda x: x["t"] >= 1.8 and x["v"] >= 1.5), ("t >= 1.2 and D2 >= 0.5", lambda x: x["t"] >= 1.2 and x["d2"] >= 0.5),
                   ("pos >= 0.9", lambda x: x["pos"] >= 0.9)):
        R = [r for r in rows if f(r)]
        print(f"| {lab} | {len(R)} ({len(R) / len(rows):.0%}) | ${sum(r['pnl'] for r in R):+,.0f} |")
    fb = [r for r in rows if r["first"] != ""]
    if fb:
        d = [r["minute"] - r["first"] for r in fb]
        print(f"\nThe bot's rule held on {len(fb)} of his {len(rows)} entries' stock-days and sides at some minute; his entry minus the bot's first minute: "
              f"median {st.median(d):+.0f} min, he was earlier on {sum(x < 0 for x in d)}, later on {sum(x > 0 for x in d)}")


if __name__ == "__main__":
    main()
