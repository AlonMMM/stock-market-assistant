"""The leader / D2 strategy on its own (the user, 2026-10-30: "do not compare this to the champion for now. we are just
try somthing else. show me benchmark only for this strategy"): the fixed benchmark table of each peer_rank.py version,
tune and check, fair list and Favorites, from peer_rank_entries.json (main entries + pyramid adds, real quotes).

  python3 peer_rank_bench.py      (from the app repo root, after peer_rank.py)
"""
import collections, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr

B = "data/local/x/bt"
J = json.load(open(f"{B}/peer_rank_entries.json"))
VERS = ["d2-20", "d2-15", "top2", "top1", "top2-d2-20", "top2-d2-15", "top1-d2-20", "top1-d2-15"]
out = {}
for part in ("tune", "check"):
    for src, lab in (("fair", "fair list"), ("fav", "Favorites, 24 months")):
        print(f"\n#### {part.capitalize()} weeks, {lab}, from $100,000 (each trade on its own at $10K: 2% returns, the 10% night cap)\n")
        print("| Version | Trades (+ adds) | Winners | Per trade | Median trade | Giants (+300%) | Without the giants | At 2% / worst drop | At 3% / worst drop | 2024 / 2025 / 2026 | Without the best 5 (2%) | Best 5 |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in VERS:
            E = J[f"{v}|{src}|{part}"]
            u = [1e4 * e["w"] * max(-1, e["r"]["0.02"]) for e in E]
            g = [x for x in u if x >= 3e4 * 1]
            s2 = rr.stats([(e["date"], 0, e["w"], e["r"]["0.02"], e["over"]) for e in E], 0.02)
            s3 = rr.stats([(e["date"], 0, e["w"], e["r"]["0.03"], e["over"]) for e in E], 0.03)
            yr = collections.defaultdict(float)
            for e, x in zip(E, u): yr[e["date"][:4]] += x
            top = sorted(zip(E, u), key=lambda q: -q[1])[:5]
            mains = sum(e["w"] == 1.0 for e in E)
            print(f"| {v} | {mains} (+{len(E) - mains}) | {sum(x > 0 for x in u)} ({sum(x > 0 for x in u) / max(1, len(u)):.0%}) | ${sum(u) / max(1, len(u)):+,.0f} | "
                  f"${st.median(u) if u else 0:+,.0f} | {len(g)} | ${sum(u) - sum(g):+,.0f} | ${s2['acct']:,} / {s2['dd']:.0%} | ${s3['acct']:,} / {s3['dd']:.0%} | "
                  f"{' / '.join(f'${yr[y] / 1e3:+,.0f}K' for y in ('2024', '2025', '2026'))} | ${s2['no5']:,} | "
                  f"{', '.join(f'{e['sym']} {e['date'][2:]} {x / 1e3:+.0f}K' for e, x in top)} |", flush=True)
