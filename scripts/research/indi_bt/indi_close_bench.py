"""The last-3-minutes strategy on its own (the user, 2026-10-30: "lets focus from now the last 3 minutes trading ... I want
to see this benchmark"): the benchmark table of each indi_close.py IC_SET=rs version (buy at 15:57, out next morning),
tune and check, fair list and Favorites, from indi_close_rs_trades.json; no champion beside it.

  python3 indi_close_bench.py [version ...]     (from the app repo root, after IC_SET=rs indi_close.py)
"""
import collections, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr

B = "data/local/x/bt"
J = json.load(open(f"{B}/indi_close_rs_trades.json"))
VERS = sys.argv[1:] or sorted({k.split("|")[0] for k in J}, key=lambda v: list(dict.fromkeys(k.split("|")[0] for k in J)).index(v))
for part in ("tune", "check"):
    for src, lab in (("fair", "fair list"), ("fav", "Favorites, 24 months")):
        print(f"\n#### {part.capitalize()} weeks, {lab}, from $100,000 (each trade at $10K: 2% returns, the 10% night cap)\n")
        print("| Version | Trades | Winners | Per trade | Median | Giants | Without giants | At 2% / worst drop | At 3% / worst drop | 2024 / 2025 / 2026 | Without best 5 (2%) | Best 3 |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in VERS:
            E = J[f"{v}|{src}|{part}"]
            u = [1e4 * max(-1, e["r"]["0.02"]) for e in E]
            g = [x for x in u if x >= 3e4]
            s2 = rr.stats([(e["date"], 389, 1.0, e["r"]["0.02"], 1) for e in E], 0.02)
            s3 = rr.stats([(e["date"], 389, 1.0, e["r"]["0.03"], 1) for e in E], 0.03)
            yr = collections.defaultdict(float)
            for e, x in zip(E, u): yr[e["date"][:4]] += x
            top = sorted(zip(E, u), key=lambda q: -q[1])[:3]
            n = max(1, len(u))
            print(f"| {v} | {len(u)} | {sum(x > 0 for x in u)} ({sum(x > 0 for x in u) / n:.0%}) | ${sum(u) / n:+,.0f} | ${st.median(u) if u else 0:+,.0f} | {len(g)} | "
                  f"${sum(u) - sum(g):+,.0f} | ${s2['acct']:,} / {s2['dd']:.0%} | ${s3['acct']:,} / {s3['dd']:.0%} | "
                  f"{' / '.join(f'${yr[y] / 1e3:+,.0f}K' for y in ('2024', '2025', '2026'))} | ${s2['no5']:,} | "
                  f"{', '.join(f'{e['sym']} {e['date'][2:]} {x / 1e3:+.0f}K' for e, x in top)} |")
