"""The big drops of e (the user, 2026-11-07: "Wdyt can help with the drop / Can you show me analyse of big drops?").
e's trades (be_ramp_R.pkl), 2%, all weeks; each list its own account. 1) every drop of 12.5%+ (high -> low -> back to the
high): its dates, length, trades, winners, the share that never reached +50%, the worst days, what ended it. 2) every
main trade by what was known at its entry: the account's drop, the last 10 trades' winners, SPY's 5 / 20-day move and
20-day volatility, SPY's move that day to the entry, trades already that day, side, tier, D2, entry hour; per bucket
the median, win rate, sum, non-giant sum and giants, on tune and check apart.

  node --env-file=.env <dir>/run.mjs drop_anal.py
-> data/local/x/bt/drop_anal.json
"""
import bisect, collections, json, math, os, pickle, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import dd_base as DB
import store
from split import half

V = "e-c5"
R, adds = pickle.load(open(f"{DB.BR.B}/be_ramp_R.pkl", "rb"))
DAYS = sorted(DB.BR.CAL) if not isinstance(DB.BR.CAL, dict) else sorted(DB.BR.CAL)
SPY = {}


def spy_close(d):
    if d not in SPY:
        b = store.day("SPY", d); SPY[d] = b[-1][4] if b else None
    return SPY[d]


def spy_ctx(d, minute):
    i = bisect.bisect_left(DAYS, d)
    prev = [x for x in DAYS[max(0, i - 25):i] if spy_close(x)]
    c = [spy_close(x) for x in prev]
    if len(c) < 21: return None
    r = [math.log(c[k] / c[k - 1]) for k in range(len(c) - 20, len(c))]
    b = store.day("SPY", d)
    day_mv = (b[min(minute, len(b) - 1)][4] / c[-1] - 1) if b else 0.0
    return dict(m5=c[-1] / c[-6] - 1, m20=c[-1] / c[-21] - 1, vol=st.pstdev(r) * math.sqrt(252), day=day_mv)


def curve(E, pct=0.02):
    """dd_base.account's marked daily account: [(day, value)], and each entry's account drop at its day's open."""
    by = collections.defaultdict(list)
    for e in E: by[e[0]].append(e)
    days = sorted(set(by) | {e[3]["h"]["exit_day"] or e[0] for e in E})
    eq, peak, open_, prev, cv, dd_at = 1e5, 1e5, [], None, [], {}
    for d in days:
        base = eq + sum(s * t[3]["h"]["marks"].get(prev, 0.0) * t[2] for s, t, _ in open_)
        dd_at[d] = 1 - base / peak
        for e in by.get(d, []):
            r_ = max(-1, DB.ret(e[3], pct * e[4])) * e[2]
            open_.append((pct * base, e, r_))
        keep = []
        for s, t, r_ in open_:
            if (t[3]["h"]["exit_day"] or t[0]) == d: eq += s * r_
            else: keep.append((s, t, r_))
        open_ = keep
        now = eq + sum(s * t[3]["h"]["marks"].get(d, 0.0) * t[2] for s, t, _ in open_)
        peak = max(peak, now); cv.append((d, now)); prev = d
    return cv, dd_at


def episodes(cv, lvl=0.125):
    out, pk, pkd, lo, lod = [], cv[0][1], cv[0][0], None, None
    for d, v in cv:
        if v >= pk:
            if lo is not None and 1 - lo / pk >= lvl: out.append(dict(start=pkd, low=lod, end=d, depth=1 - lo / pk))
            pk, pkd, lo, lod = v, d, None, None
        elif lo is None or v < lo: lo, lod = v, d
    if lo is not None and 1 - lo / pk >= lvl: out.append(dict(start=pkd, low=lod, end=None, depth=1 - lo / pk))
    return out


def peak_gain(x):
    return max([u for s_, u in x["held"].values() if s_ > 0 and u is not None] or [-1])


def bucket_table(rows, key, cuts, label):
    print(f"\n#### {label}\n\n| Bucket | Tune: n · win · median · sum · non-giant · giants | Check: the same |\n|---|---|---|")
    res = {}
    for name, f in cuts:
        cells = []
        for part in ("tune", "check"):
            g = [r for r in rows if r["part"] == part and f(r[key])]
            usd = [r["usd"] for r in g]
            gi = [r for r in g if r["ret"] >= 3.0]
            ng = sum(u for r, u in zip(g, usd) if r["ret"] < 3.0)
            cells.append(f"{len(g)} · {sum(r['ret'] > 0 for r in g) / max(1, len(g)):.0%} · {round(st.median(usd)) if usd else 0:+,} · {round(sum(usd)):+,} · {round(ng):+,} · {len(gi)}")
            res[f"{name}|{part}"] = dict(n=len(g), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)), nongiant=round(ng), giants=len(gi))
        print(f"| {name} | {cells[0]} | {cells[1]} |", flush=True)
    return res


def main():
    out = {}
    for src, a in (("fair", ""), ("fav", DB.FR.A24)):
        E = DB.entries(R, adds, src, "all", a)
        cv, dd_at = curve(E)
        eps = episodes(cv)
        mains = sorted([r for r in R if r["src"] == src and r["kind"] == "main" and r["date"] >= a], key=lambda r: (r["date"], r["minute"]))
        print(f"\n### {src}: e at 2%, all weeks, end ${cv[-1][1]:,.0f}; drops of 12.5%+\n")
        print("| High | Low | Back at the high | Depth | Trading days | Trades | Winners | Never +50% (their sum) | Worst 3 days (share of the fall) | Best trades after the low |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        val = dict(cv)
        for ep in eps:
            T = [r for r in mains if ep["start"] < r["date"] <= ep["low"]]
            usd = {id(r): 1e4 * DB.SV.SIZEV[V](r["rvol"]) * max(-1, r["v"][V]["r2"]) for r in T}
            never = [r for r in T if peak_gain(r["v"][V]) < 0.5]
            ds = [d for d, _ in cv if ep["start"] <= d <= ep["low"]]
            chg = sorted(((val[ds[k]] - val[ds[k - 1]], ds[k]) for k in range(1, len(ds))))
            fall = val[ep["start"]] - val[ep["low"]]
            w3 = chg[:3]
            after = [r for r in mains if ep["low"] < r["date"] <= (ep["end"] or "9")]
            top = sorted(after, key=lambda r: -DB.SV.SIZEV[V](r["rvol"]) * r["v"][V]["r2"])[:3]
            print(f"| {ep['start']} | {ep['low']} | {ep['end'] or 'not yet'} | {ep['depth']:.1%} | {len(ds)} | {len(T)} | {sum(r['v'][V]['r2'] > 0 for r in T)} | "
                  f"{len(never)} ({sum(usd[id(r)] for r in never):+,.0f}) | {', '.join(f'{d} {-c / fall:.0%}' for c, d in w3)} | "
                  f"{', '.join(f'{r['sym']} {r['date']} {r['v'][V]['r2']:+.0%}' for r in top)} |", flush=True)
        # every main trade, what was known at its entry
        rows, last = [], collections.deque(maxlen=10)
        per_day = collections.Counter()
        for r in mains:
            x = r["v"][V]; ctx = spy_ctx(r["date"], r["minute"])
            if ctx is None: continue
            ret = max(-1, x["r2"])
            rows.append(dict(part=half(r["date"]), ret=ret, usd=1e4 * DB.SV.SIZEV[V](r["rvol"]) * ret, dd=dd_at.get(r["date"], 0.0),
                             last10=sum(last) if len(last) == 10 else None, today=per_day[r["date"]], side=r["right"],
                             w=DB.SV.SIZEV[V](r["rvol"]), d2=r["d2"], hour=r["minute"] // 60, **ctx))
            last.append(int(ret > 0)); per_day[r["date"]] += 1
        print(f"\n### {src}: every main trade by what was known at entry (2%, at $10K x its tier)")
        o = dict(episodes=eps)
        o["dd"] = bucket_table(rows, "dd", [("account at its high (<2.5% under)", lambda v: v < 0.025), ("2.5-12.5% under", lambda v: 0.025 <= v < 0.125),
                                            ("12.5-25% under", lambda v: 0.125 <= v < 0.25), ("25%+ under", lambda v: v >= 0.25)], "The account's drop at entry")
        o["last10"] = bucket_table([r for r in rows if r["last10"] is not None], "last10", [("0 of the last 10 won", lambda v: v == 0), ("1", lambda v: v == 1),
                                   ("2", lambda v: v == 2), ("3-4", lambda v: 3 <= v <= 4), ("5+", lambda v: v >= 5)], "Winners in the last 10 trades")
        o["m20"] = bucket_table(rows, "m20", [("SPY 20 days < -5%", lambda v: v < -0.05), ("-5% to 0", lambda v: -0.05 <= v < 0), ("0 to +3%", lambda v: 0 <= v < 0.03),
                                ("+3%+", lambda v: v >= 0.03)], "SPY's 20-day move before the entry day")
        o["m5"] = bucket_table(rows, "m5", [("SPY 5 days < -2%", lambda v: v < -0.02), ("-2% to 0", lambda v: -0.02 <= v < 0), ("0 to +2%", lambda v: 0 <= v < 0.02),
                               ("+2%+", lambda v: v >= 0.02)], "SPY's 5-day move before the entry day")
        o["vol"] = bucket_table(rows, "vol", [("SPY 20-day vol < 12%", lambda v: v < 0.12), ("12-18%", lambda v: 0.12 <= v < 0.18), ("18-25%", lambda v: 0.18 <= v < 0.25),
                                ("25%+", lambda v: v >= 0.25)], "SPY's 20-day volatility (a VIX stand-in)")
        o["day"] = bucket_table(rows, "day", [("SPY down 0.5%+ to the entry", lambda v: v <= -0.005), ("-0.5% to 0", lambda v: -0.005 < v < 0), ("0 to +0.5%", lambda v: 0 <= v < 0.005),
                                ("up 0.5%+", lambda v: v >= 0.005)], "SPY's move that day, to the entry minute")
        o["today"] = bucket_table(rows, "today", [("first trade of the day", lambda v: v == 0), ("2nd", lambda v: v == 1), ("3rd+", lambda v: v >= 2)], "Trades already that day")
        o["side"] = bucket_table(rows, "side", [("calls", lambda v: v == "C"), ("puts", lambda v: v == "P")], "Side")
        o["w"] = bucket_table(rows, "w", [(f"tier {w}", (lambda w: lambda v: abs(v - w) < 1e-9)(w)) for w in sorted({r["w"] for r in rows})], "The volume tier (size)")
        o["hour"] = bucket_table(rows, "hour", [("09:30-10:30", lambda v: v == 0), ("10:30-11:30", lambda v: v == 1), ("11:30-13:30", lambda v: 2 <= v <= 3), ("13:30+", lambda v: v >= 4)], "Entry hour (New York)")
        out[src] = o
    json.dump(out, open(f"{DB.BR.B}/drop_anal.json", "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
