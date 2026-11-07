"""A placebo for the falling-day skip (the user, 2026-11-07: "2022 and 2023 is too wek for the test"): on e's 2024-26
trades (2%, all weeks, each list), skip the trades of N random trading days, N set so the skipped main legs match the
rule's count, 1,000 draws; where do S05 (SPY down 0.5%+ at the entry) and E5-T26 fall among the draws, on the end money,
the booked drop and the giants skipped? A random day carries the market's own clustering (giants come in groups).

  node --env-file=.env <dir>/run.mjs spy_placebo.py
"""
import os, pickle, random, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import spy_bar as SB
DB = SB.DB
R, adds = pickle.load(open(f"{DB.BR.B}/be_ramp_R.pkl", "rb"))
random.seed(7)
for src, a in (("fair", ""), ("fav", DB.FR.A24)):
    mains = [r for r in R if r["src"] == src and r["kind"] == "main" and r["date"] >= a]
    base = SB.SD.stats(DB.entries(R, adds, src, "all", a))
    for name in ("S05", "E5-T26"):
        if name == "S05": keep = lambda r: SB.SD.spy_day(r["date"], r["minute"]) > -0.005
        else: keep = lambda r, v=SB.VERS[name]: SB.ok(src, r["date"], r["sym"], r["right"], r["minute"], r["rvol"], v)
        rule = SB.SD.stats(DB.entries(R, adds, src, "all", a, keep=keep))
        sk = [r for r in mains if not keep(r)]
        n, gs = len(sk), sum(r["v"]["e-c5"]["r2"] >= 3 for r in sk)
        days = sorted({r["date"] for r in mains}); per = {d: sum(r["date"] == d for r in mains) for d in days}
        draws = []
        for _ in range(1000):
            random.shuffle(days); pick, c = set(), 0
            for d in days:
                if c >= n: break
                pick.add(d); c += per[d]
            s = SB.SD.stats(DB.entries(R, adds, src, "all", a, keep=lambda r: r["date"] not in pick))
            g = sum(r["v"]["e-c5"]["r2"] >= 3 for r in mains if r["date"] in pick)
            draws.append((s["acct"] / base["acct"], s["bdd"], g))
        ratio = rule["acct"] / base["acct"]
        beat = sum(d[0] >= ratio for d in draws) / len(draws)
        dd = sum(d[1] <= rule["bdd"] for d in draws) / len(draws)
        g0 = sum(d[2] <= gs for d in draws) / len(draws)
        q = sorted(d[0] for d in draws)
        print(f"{src} {name}: skips {n} trades ({gs} giants); end vs e {ratio:.3f}, booked drop {rule['bdd']:.1%} (e {base['bdd']:.1%}). "
              f"Random days: end median {q[500]:.3f}, 95th pct {q[950]:.3f}; as good or better {beat:.1%}; drop as small {dd:.1%}; "
              f"<= {gs} giants skipped {g0:.1%}", flush=True)
