"""The big-winner game (the user 2026-10-31: "we want a big move, and if we hit 1/8 big we will win", "go and test it").
Reads indi_close.py IC_SET=delta (today's pick, the fair list and the Favorites as ONE list: a bet on both is counted
once) and nightly_bt.py NB_SET=delta (the v2 score on ~310 stocks). Per version and half, on unique bets at their real
fills: bets, the big-winner rate (+300% or more on the premium) and their average, the other bets' average, the rate a
break-even needs (the others' average loss against the big winners' average), the average per bet, the median, and the
account from $100,000 at 2% a bet. Picked on tune per rule by the average per bet; the pick and delta 0.20 on check.

  python3 scripts/research/indi_bt/bigrate.py      (from the app repo root)
"""
import json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import retry_roll as rr

B = "data/local/x/bt"


def unique_close(path):
    D = json.load(open(path)); out = {}
    for k, v in D.items():
        ver, src, part = k.split("|")
        for x in v: out.setdefault((ver, part), {})[(x["date"], x["sym"], x["right"])] = x
    return {k: sorted(v.values(), key=lambda x: x["date"]) for k, v in out.items()}


def nightly(path):
    D = json.load(open(path))
    return {tuple(k.split("|")): sorted(v, key=lambda x: x["date"]) for k, v in D.items()}


def row(T):
    r = [max(-1.0, x["r"]["0.02"]) for x in T]
    if not r: return None
    big = [x for x in r if x >= 3]; rest = [x for x in r if x < 3]
    mb = st.fmean(big) if big else 0.0; mr = st.fmean(rest) if rest else 0.0
    be = -mr / (mb - mr) if big and mb > mr and mr < 0 else None
    acc = rr.stats([(x["date"], 389, 1.0, x["r"]["0.02"], 1) for x in T], 0.02)
    return dict(n=len(r), big=len(big), rate=len(big) / len(r), mb=mb, mr=mr, be=be, mean=st.fmean(r), med=st.median(r), acct=acc["acct"], dd=acc["dd"])


def show(title, data, versions, ref):
    print(f"\n### {title}\n\n| Version | Half | Bets | Big winners (+300%) | Their average | Others' average | Break-even rate | Average per bet | Median | $100K at 2% / worst drop |\n|---|---|---|---|---|---|---|---|---|---|")
    tune = {}
    for v in versions:
        s = row(data.get((v, "tune"), []))
        if not s: continue
        tune[v] = s
        print(fmt(v, "tune", s))
    pick = max((v for v in tune if v != ref), key=lambda v: tune[v]["mean"])
    print(f"\nPicked on tune: {pick} 🎯")
    for v in (ref, pick):
        s = row(data.get((v, "check"), []))
        if s: print(fmt(v, "check", s))


def fmt(v, h, s):
    be = f"{s['be']:.1%} (1 in {1 / s['be']:.0f})" if s["be"] else "-"
    rate = f"{s['big']} = {s['rate']:.1%}" + (f" (1 in {1 / s['rate']:.0f})" if s["rate"] else "")
    return (f"| {v} | {h} | {s['n']} | {rate} | {s['mb']:+.0%} | {s['mr']:+.0%} | {be} | {s['mean']:+.0%} | {s['med']:+.0%} | "
            f"${s['acct']:,} / {s['dd']:.0%} |")


if __name__ == "__main__":
    A = unique_close(f"{B}/indi_close_delta_trades.json")
    show("A. Today's pick (t >= 1.8), the fair list + the Favorites as one list, next-day option", A,
         ["t18-d10", "t18-d15", "t18-d20", "t18-d30"], "t18-d20")
    N = nightly(f"{B}/nightly_bt_delta_trades.json")
    show("B. The v2 score (activity 3 + SPY 2), ~310 stocks, next-day or 1-4 day option", N,
         ["a3r2p0-d10", "a3r2p0-d15", "a3r2p0-d20", "a3r2p0-d30"], "a3r2p0-d20")
