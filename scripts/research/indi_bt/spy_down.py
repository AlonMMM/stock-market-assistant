"""Skip a new entry when SPY is down on the day at the entry minute (the user, 2026-11-07: "Yes. Check this theses", after
drop_anal.py: SPY down 0.5%+ to the entry = 0-1 giants and a loss on both lists and halves; "dont we have bigger winner
to the put side?" - no, puts there had 0 giants too). On e (be_ramp_R.pkl), at 2%: the main leg and its adds are skipped
when SPY's last minute close before the entry is at least x under the prior session's close. Set before running:
  S05 x = 0.5%, S075 x = 0.75%, S10 x = 1.0%
Look: drop_anal saw both halves of the bucket, so the check here is weak evidence; 2022-23 (2.10's real-quote trades,
y2022 / y2023 trades_v210x.csv, main legs) is the unseen part. Both drops are shown: marked (the account's value with open
trades) and booked (the user, the same day: "a trade is mark on his end, so drop from the top of a trade is not relevant,
only after the mony is in our account").

  node --env-file=.env <dir>/run.mjs spy_down.py
"""
import bisect, csv, json, os, pickle, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import dd_base as DB
import store
from split import half

VERS = {"e": None, "S05": 0.005, "S075": 0.0075, "S10": 0.01}
CAL = sorted(DB.BR.CAL)
_prev = {}


def spy_day(d, minute):
    """SPY's move from the prior session's close to the close of the minute before the entry."""
    if d not in _prev:
        i = bisect.bisect_left(CAL, d); p = None
        for x in reversed(CAL[max(0, i - 6):i]):
            b = store.day("SPY", x)
            if b: p = b[-1][4]; break
        _prev[d] = p
    b = store.day("SPY", d)
    if not b or not _prev[d]: return 0.0
    return b[max(0, min(minute - 1, len(b) - 1))][4] / _prev[d] - 1


def entries(R, adds, src, part, a, x):
    if x is None: return DB.entries(R, adds, src, part, a)
    return DB.entries(R, adds, src, part, a, keep=lambda r: spy_day(r["date"], r["minute"]) > -x)


def stats(E, pct=0.02):
    s = DB.account(E, pct, None)
    main = [e for e in E if e[4] == 1.0]
    usd = [1e4 * e[2] * max(-1, e[3]["r2"]) for e in main]
    g = [u for e, u in zip(main, usd) if e[3]["r2"] >= 3.0]
    top = sorted(usd, reverse=True)
    a5 = DB.account([e for e in E if not (e[4] == 1.0 and 1e4 * e[2] * max(-1, e[3]["r2"]) in set(top[:5]))], pct, None)["acct"]
    return dict(**s, win=sum(e[3]["r2"] > 0 for e in main) / max(1, len(main)), median=round(st.median(usd)) if usd else 0,
                g_n=len(g), nongiant=round(sum(usd) - sum(g)), no5=a5, mains=len(main))


def y2223(x):
    """2.10's main legs on 2022 / 2023, real quotes, booked on the entry day (the file has no sale day), 2% x tier."""
    out = {}
    for y in ("2022", "2023"):
        rows = [r for r in csv.DictReader(open(f"{DB.BR.B}/y{y}/trades_v210x.csv")) if r["kind"] == "main" and r["news_ok"] == "1"]
        if x is not None: rows = [r for r in rows if spy_day(r["date"], int(r["minute"])) > -x]
        eq, pk, dd = 1e5, 1e5, 0.0
        usd = []
        for r in sorted(rows, key=lambda r: (r["date"], int(r["minute"]))):
            w = DB.SV.SIZEV["t3A-c5"](float(r["rvol"] or 0)); ret = max(-1, float(r["r2"]))
            eq += 0.02 * eq * w * ret; pk = max(pk, eq); dd = max(dd, 1 - eq / pk); usd.append((1e4 * w * ret, ret))
        out[y] = dict(n=len(rows), acct=round(eq), bdd=round(dd, 3), win=sum(r > 0 for _, r in usd) / max(1, len(usd)),
                      giants=sum(r >= 3 for _, r in usd), sum=round(sum(u for u, _ in usd)), median=round(st.median([u for u, _ in usd])) if usd else 0)
    return out


def main():
    R, adds = pickle.load(open(f"{DB.BR.B}/be_ramp_R.pkl", "rb"))
    out = {}
    print("\n### e with the SPY-down skip, 2% from $100,000, real quotes\n")
    print("| Version | Part | List | Main trades | Winners | Median | Giants · non-giant sum | End | vs e | Drop marked | **Drop booked** | Without the best 5 |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for part in ("tune", "check", "all"):
        for src, a in (("fair", ""), ("fav", DB.FR.A24)):
            for v, x in VERS.items():
                s = stats(entries(R, adds, src, part, a, x)); out[f"{part}|{src}|{v}"] = s
                b = out[f"{part}|{src}|e"]
                print(f"| {v} | {part} | {src} | {s['mains']} | {s['win']:.1%} | {s['median']:+,} | {s['g_n']} · {s['nongiant']:+,} | ${s['acct']:,} | {s['acct'] / b['acct']:.3f} | {s['dd']:.1%} | **{s['bdd']:.1%}** | ${s['no5']:,} |", flush=True)
    print("\n### 2022 / 2023, 2.10's main legs (real quotes, unseen), 2% x tier, booked on the entry day\n")
    print("| Version | 2022: trades · winners · giants · sum · end / booked drop | 2023: the same |\n|---|---|---|")
    for v, x in VERS.items():
        y = y2223(x); out[f"y2223|{v}"] = y
        print(f"| {v} | " + " | ".join(f"{y[k]['n']} · {y[k]['win']:.0%} · {y[k]['giants']} · {y[k]['sum']:+,} · ${y[k]['acct']:,} / {y[k]['bdd']:.1%}" for k in ("2022", "2023")) + " |", flush=True)
    json.dump(out, open(f"{DB.BR.B}/spy_down_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
