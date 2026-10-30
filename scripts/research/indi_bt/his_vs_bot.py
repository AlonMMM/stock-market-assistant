"""How Indi's entries differ from the bot's (the user, 2026-10-30: "I dont want to differ his winner vs his losers but to
understand his enters in general. What is different from us?").

Indi: every first buy of his main account (his_tvd.csv), Feb 2024 - Oct 2026, on any stock / ETF with minute bars, and
the same on our lists' stocks only. The bot: the champion's main entries (peer_rank_trades.json: fair list + Favorites).
At each entry minute, on the entry's side (his_tvd.arrays + d3.py): t, V, D2, D2 best today, range position, the day's
move, vs SPY, the last hour vs SPY, VWAP, SPY's own day, D3, D3-last, and the rank of t / V / D2 / range among our lists'
stocks at that minute. -> data/local/x/bt/his_vs_bot.csv + printed table.

  python3 his_vs_bot.py      (from the app repo root)
"""
import collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import his_tvd as HT
import d3 as D3
import fav_real as FR
from low_delta import HIS40

B = "data/local/x/bt"
KEYS = ("t", "v", "d2", "d2max", "pos", "move", "exday", "ex60", "vwap", "spy")


def one_day(job):
    date, E = job
    syms = sorted(set(HT.PEERS) | {e["sym"] for e in E})
    A = {s: HT.arrays(s, date) for s in syms}
    out = []
    for e in E:
        a = A.get(e["sym"])
        m = e["minute"]
        if not a or m not in a[e["right"]]: continue
        x = a[e["right"]][m]
        peers = [A[s][e["right"]][m] for s in HT.PEERS if s != e["sym"] and A.get(s) and m in A[s][e["right"]]]
        r = dict(e, **{k: x[k] for k in KEYS})
        for k in ("t", "v", "d2", "pos"):
            r[f"rk_{k}"] = round(100 * sum(p[k] < x[k] for p in peers) / len(peers)) if peers else None
        try: d = D3.d3(e["sym"], date, m, e["right"])
        except Exception: d = None
        r["d3"] = d["d3"] if d else None
        r["d3_last"] = d["d3_last"] if d else None
        out.append(r)
    return out


def main():
    E = []
    for h in csv.DictReader(open(f"{B}/his_tvd.csv")):
        if h["date"] < "2024-02-01": continue
        E.append(dict(who="indi", date=h["date"], sym=h["sym"], right=h["right"], minute=int(h["minute"]), night=int(h["night"]),
                      onlist=int(h["sym"] in HIS40 or h["sym"] in FR.FAV), dte=int(h["dte"]), otm=float(h["otm"]) if h["otm"] else None, ret=float(h["ret"])))
    seen = set()
    for t in json.load(open(f"{B}/peer_rank_trades.json")):
        k = (t["date"], t["sym"], t["right"])
        if k in seen: continue
        seen.add(k)
        E.append(dict(who="bot", date=t["date"], sym=t["sym"], right=t["right"], minute=int(t["minute"]), night=None, onlist=1, dte=None, otm=None, ret=t["r2"]))
    by = collections.defaultdict(list)
    for e in E: by[e["date"]].append(e)
    with mp.Pool(8) as pool: R = [r for rows in pool.map(one_day, sorted(by.items()), chunksize=4) for r in rows]
    with open(f"{B}/his_vs_bot.csv", "w") as f:
        w = csv.DictWriter(f, list(R[0])); w.writeheader(); w.writerows(R)
    groups = (("Indi, all his stocks", lambda r: r["who"] == "indi"), ("Indi, our lists' stocks", lambda r: r["who"] == "indi" and r["onlist"]), ("The bot", lambda r: r["who"] == "bot"))
    G = [(g, [r for r in R if f(r)]) for g, f in groups]
    md = lambda X, k: st.median([r[k] for r in X if r[k] is not None])
    sh = lambda X, f: sum(1 for r in X if f(r)) / len(X)
    lines = [("Entries", lambda X: f"{len(X)}"), ("Distinct stocks", lambda X: f"{len({r['sym'] for r in X})}"),
             ("Entries a trading day (days with one)", lambda X: f"{len(X) / len({r['date'] for r in X}):.2f}"),
             ("Calls", lambda X: f"{sh(X, lambda r: r['right'] == 'C'):.0%}"),
             ("Before 10:00", lambda X: f"{sh(X, lambda r: r['minute'] < 30):.0%}"), ("10:00-12:00", lambda X: f"{sh(X, lambda r: 30 <= r['minute'] < 150):.0%}"),
             ("12:00-15:00", lambda X: f"{sh(X, lambda r: 150 <= r['minute'] < 330):.0%}"), ("15:00 and later", lambda X: f"{sh(X, lambda r: r['minute'] >= 330):.0%}"),
             ("Median entry time", lambda X: (lambda m: f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}")(int(md(X, 'minute')))),
             ("t (median)", lambda X: f"{md(X, 't'):.2f}"), ("t >= 1.8", lambda X: f"{sh(X, lambda r: r['t'] >= 1.8):.0%}"),
             ("V (median)", lambda X: f"{md(X, 'v'):.2f}"), ("V >= 1.5", lambda X: f"{sh(X, lambda r: r['v'] >= 1.5):.0%}"),
             ("D2 (median)", lambda X: f"{md(X, 'd2'):.2f}"), ("D2 best today (median)", lambda X: f"{md(X, 'd2max'):.2f}"),
             ("D3 (median)", lambda X: f"{md(X, 'd3'):.2f}"), ("D3-last (median)", lambda X: f"{md(X, 'd3_last'):.2f}"),
             ("Range position (1 = day's high, his side)", lambda X: f"{md(X, 'pos'):.2f}"), ("At the day's high (>= 0.97)", lambda X: f"{sh(X, lambda r: r['pos'] >= 0.97):.0%}"),
             ("Day's move his way", lambda X: f"{md(X, 'move'):+.1%}"), ("Day's move vs SPY x beta", lambda X: f"{md(X, 'exday'):+.1%}"),
             ("Last hour vs SPY x beta", lambda X: f"{md(X, 'ex60'):+.2%}"), ("Above VWAP his way", lambda X: f"{sh(X, lambda r: r['vwap'] > 0):.0%}"),
             ("SPY's day on his side", lambda X: f"{md(X, 'spy'):+.2%}"), ("SPY with him (> 0)", lambda X: f"{sh(X, lambda r: r['spy'] > 0):.0%}"),
             ("Rank of t among our stocks", lambda X: f"{md(X, 'rk_t'):.0f}"), ("Rank of V", lambda X: f"{md(X, 'rk_v'):.0f}"),
             ("Rank of D2", lambda X: f"{md(X, 'rk_d2'):.0f}"), ("Rank of range position", lambda X: f"{md(X, 'rk_pos'):.0f}")]
    print("| Measure at the entry minute | " + " | ".join(g for g, _ in G) + " |\n|---|" + "---|" * len(G))
    for lab, f in lines: print(f"| {lab} | " + " | ".join(f(X) for _, X in G) + " |")
    I = G[0][1]
    print(f"\nIndi only: held overnight {sh(I, lambda r: r['night']):.0%}; days to expiry median {md(I, 'dte'):.0f} (0DTE {sh(I, lambda r: r['dte'] == 0):.0%}, 1-2 {sh(I, lambda r: 1 <= r['dte'] <= 2):.0%}, 3-7 {sh(I, lambda r: 3 <= r['dte'] <= 7):.0%}); "
          f"out of the money median {md(I, 'otm'):.1%}")
    top = collections.Counter(r["sym"] for r in I).most_common(12); topb = collections.Counter(r["sym"] for r in G[2][1]).most_common(12)
    print("Indi's most traded:", ", ".join(f"{s} {n}" for s, n in top)); print("The bot's most traded:", ", ".join(f"{s} {n}" for s, n in topb))


if __name__ == "__main__":
    main()
