"""The 40 watchlist stocks with the tightest strangles (the user, 2026-10-27: "only the top 40 liquid names - there the
spread should be very small"): the median spread of the 0.35-delta call + put at each alert over the 12 months, from
the real quotes (strangle_cache), stocks with 5+ alerts. -> strangle_top40.json
"""
import collections, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import strangle_real as S


def spread(e):
    pr = S.pair(e, 0.35)
    if not pr: return None
    return e["sym"], sum(q[1] - q[0] for c, q in pr.values()) / sum((q[1] + q[0]) / 2 for c, q in pr.values())


if __name__ == "__main__":
    ev = json.load(open(S.EV))
    with mp.Pool(8) as pool: res = [r for r in pool.map(spread, sorted(ev, key=lambda e: e["date"]), chunksize=16) if r]
    by = collections.defaultdict(list)
    for s, x in res: by[s].append(x)
    rank = sorted(((s, st.median(v), len(v)) for s, v in by.items() if len(v) >= 5), key=lambda r: r[1])
    for i, (s, m, n) in enumerate(rank): print(f"{i + 1:3d} {s:6s} {100 * m:5.1f}% {n}")
    json.dump([r[0] for r in rank[:40]], open(os.path.join(HERE, "strangle_top40.json"), "w"))
