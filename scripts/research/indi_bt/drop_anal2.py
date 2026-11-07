"""drop_anal follow-ups: (1) the first day after each drop's high: which open positions fell (marks); (2) SPY's move to
the entry by side; (3) SPY's 5-day move < -2% by side."""
import collections, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import drop_anal as DA
DB = DA.DB; V = DA.V
from split import half

for src, a in (("fair", ""), ("fav", DB.FR.A24)):
    E = DB.entries(DA.R, DA.adds, src, "all", a)
    cv, _ = DA.curve(E); val = dict(cv); days = [d for d, _ in cv]
    print(f"\n## {src}: the first days after each high")
    for ep in DA.episodes(cv):
        i = days.index(ep["start"]); d1 = days[i + 1]
        fall = val[ep["start"]] - val[ep["low"]]; f1 = val[ep["start"]] - val[d1]
        # positions open over the high's close: entered on/before the high, exit after it
        op = [e for e in E if e[0] <= ep["start"] and (e[3]["h"]["exit_day"] or e[0]) > ep["start"]]
        mv = []
        for e in op:
            m0 = e[3]["h"]["marks"].get(ep["start"], 0.0); m1 = e[3]["h"]["marks"].get(d1)
            if m1 is None: m1 = max(-1, e[3]["r2"]) if (e[3]["h"]["exit_day"] or e[0]) == d1 else m0
            mv.append((e[2] * (m1 - m0), e[0], e[2], m0, m1))
        new = [e for e in E if e[0] == d1]
        print(f"  high {ep['start']} -> {d1}: {f1 / fall:.0%} of the fall ({f1 / val[ep['start']]:.1%} of the account); "
              f"{len(op)} open over the night, their marks moved {sum(m[0] for m in mv):+.2f} units (top: "
              + ", ".join(f"{m[1]} +{m[3]:.0%}->{m[4]:+.0%}" for m in sorted(mv)[:3]) + f"); {len(new)} new entries that day")
    rows = []
    for r in sorted([r for r in DA.R if r["src"] == src and r["kind"] == "main" and r["date"] >= a], key=lambda r: (r["date"], r["minute"])):
        ctx = DA.spy_ctx(r["date"], r["minute"])
        if not ctx: continue
        ret = max(-1, r["v"][V]["r2"])
        rows.append(dict(part=half(r["date"]), ret=ret, usd=1e4 * DB.SV.SIZEV[V](r["rvol"]) * ret, side=r["right"], day=ctx["day"], m5=ctx["m5"]))
    for side in ("C", "P"):
        S = [r for r in rows if r["side"] == side]
        DA.bucket_table(S, "day", [("SPY down 0.5%+", lambda v: v <= -0.005), ("-0.5% to +0.5%", lambda v: -0.005 < v < 0.005), ("up 0.5%+", lambda v: v >= 0.005)], f"{src} {side}: SPY's move to the entry")
        DA.bucket_table(S, "m5", [("SPY 5 days < -2%", lambda v: v < -0.02), ("-2% to +2%", lambda v: -0.02 <= v < 0.02), ("+2%+", lambda v: v >= 0.02)], f"{src} {side}: SPY's 5 days")
