"""Volume before Indi's late overnight buys (the user, 2026-10-30: "so volume is not a threshold for him? maybe he look on
the volume before his enter? can you check?").

For each of his late (15:00+) overnight buys on our lists (close_miss.csv), at his entry minute m, and for the other
stocks of our lists at the same minute (the peers, same day):
  day     the day's volume to m / its median to m over the 20 sessions before (the strategy's 1.3x rule)
  w5/w15/w30/w60  the last 5 / 15 / 30 / 60 minutes' volume / the median of the same minutes over the 20 sessions before
  pace30  the last 30 minutes' volume per minute / the day's volume per minute so far (speeding up > 1)
  mv15/mv30  the stock's move over the last 15 / 30 minutes, on his side
Rank: his stock's place among the peers (100 = the highest). -> data/local/x/bt/his_vol.csv + printed tables.

  python3 his_vol.py      (from the app repo root)
"""
import collections, csv, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import day, calendar
import his_tvd as HT

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
WS = (5, 15, 30, 60)


def meas(sym, date, m, bet):
    i = IDX.get(date)
    if i is None or i < 21: return None
    v, c = [0] * 390, [None] * 390
    for x in day(sym, date):
        if 0 <= x[0] < 390: v[x[0]], c[x[0]] = x[5], x[4]
    if sum(v[:m + 1]) == 0: return None
    hist = []
    for d in CAL[i - 20:i]:
        h = [0] * 390
        for x in day(sym, d):
            if 0 <= x[0] < 390: h[x[0]] = x[5]
        if sum(h): hist.append(h)
    if len(hist) < 10: return None
    med = lambda a, b: st.median(sum(h[a:b]) for h in hist)
    out = {}
    base = med(0, m + 1)
    out["day"] = sum(v[:m + 1]) / base if base else None
    for w in WS:
        b_ = med(max(0, m - w + 1), m + 1)
        out[f"w{w}"] = sum(v[max(0, m - w + 1):m + 1]) / b_ if b_ else None
    out["pace30"] = (sum(v[m - 29:m + 1]) / 30) / (sum(v[:m + 1]) / (m + 1)) if m >= 30 else None
    px = lambda k: next((c[j] for j in range(k, -1, -1) if c[j]), None)
    for w in (15, 30):
        a, b2 = px(m - w), px(m)
        out[f"mv{w}"] = bet * (b2 / a - 1) if a and b2 else None
    return out


KEYS = ["day", "w5", "w15", "w30", "w60", "pace30", "mv15", "mv30"]


def one(r):
    m = int(r["time"][:2]) * 60 + int(r["time"][3:5]) - 570
    bet = 1 if r["right"] == "C" else -1
    me = meas(r["sym"], r["date"], m, bet)
    if not me: return None
    peers = [p for p in (meas(s, r["date"], m, bet) for s in HT.PEERS if s != r["sym"]) if p]
    out = dict(date=r["date"], time=r["time"], sym=r["sym"], right=r["right"], his_ret=r["his_ret"], his_pnl=r["his_pnl"], **{k: None if me[k] is None else round(me[k], 3) for k in KEYS})
    for k in KEYS:
        xs = [p[k] for p in peers if p[k] is not None]
        out[f"rk_{k}"] = round(100 * sum(x < me[k] for x in xs) / len(xs)) if xs and me[k] is not None else None
    return out


def main():
    R = list(csv.DictReader(open(f"{B}/close_miss.csv")))
    with mp.Pool(8) as pool: rows = [x for x in pool.map(one, R, chunksize=2) if x]
    with open(f"{B}/his_vol.csv", "w") as f:
        w = csv.DictWriter(f, list(rows[0])); w.writeheader(); w.writerows(rows)
    G = (("all", lambda r: True), ("his winners", lambda r: float(r["his_pnl"]) > 0), ("his losers", lambda r: float(r["his_pnl"]) <= 0), ("his giants (3x+)", lambda r: float(r["his_ret"]) >= 3))
    print(f"{len(rows)} of his late overnight buys\n\n| Group | n | " + " | ".join(KEYS) + " |\n|---|---|" + "---|" * len(KEYS))
    for g, f in G:
        X = [r for r in rows if f(r)]
        print(f"| {g} median | {len(X)} | " + " | ".join(f"{st.median([r[k] for r in X if r[k] is not None]):.2f}" for k in KEYS) + " |")
        print(f"| {g} rank among peers | {len(X)} | " + " | ".join(f"{st.median([r['rk_' + k] for r in X if r['rk_' + k] is not None]):.0f}" for k in KEYS) + " |")
    print("\nThe giants:")
    for r in rows:
        if float(r["his_ret"]) >= 3: print(r["date"], r["time"], r["sym"], r["right"], r["his_ret"], {k: r[k] for k in KEYS}, {k: r["rk_" + k] for k in KEYS})


if __name__ == "__main__":
    main()
