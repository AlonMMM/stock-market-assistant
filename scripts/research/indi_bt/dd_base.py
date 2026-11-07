"""Cut the basic size after many losers, on e (the user, 2026-11-07: "what about now when we know to trade big to cut
afrer many loosers the basic trade size? for example, after drop of 12.5% to 75% size (until it up above 7.5% again) and
under 25% to 50%. all the big sizing will stay as today calculate from the basic."). On e's trades (be_ramp_R.pkl, the
e-c5 rows, no re-walk). The account's drop from its high (marked, at each entry day's open) sets a multiplier on the basic
size; every tier, the add and the pyramid add scale with it; each return at its own size (the 10% night cap at that
size, linear between the stored sizes). Set before running:
  DD    x0.75 from a 12.5% drop, back to x1 under 7.5%; x0.5 from 25%, back to x0.75 under 20%
  DDb   the same, x0.5 back to x0.75 under 25% (no gap on the second step)
Yardsticks: flat 2%, flat 1.75%, flat 1.5% (and at 3%: flat 3%, 2.5%, 2.25%). Prior: dd_sizing.py (2026-10-23),
dd_sizing_rule.py (10-27), dd 15% / 5% (10-31): every cut lost to a flat smaller size with the same drop.

  node --env-file=.env <dir>/run.mjs dd_base.py
"""
import collections, json, os, pickle, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import be_ramp as BR
import size_volume as SV
import fav_real as FR
from split import half

KEYS = [(0.005, "r05"), (0.01, "r1"), (0.015, "r15"), (0.02, "r2"), (0.025, "r25"), (0.03, "r3"), (0.05, "r5")]
RULES = {"DD": [(0.125, 0.075, 0.75), (0.25, 0.20, 0.5)], "DDb": [(0.125, 0.075, 0.75), (0.25, 0.25, 0.5)]}


def ret(x, size):
    """The return at this size, linear between the stored sizes."""
    for (a, ka), (b, kb) in zip(KEYS, KEYS[1:]):
        if a <= size <= b:
            f = (size - a) / (b - a)
            return (1 - f) * x[ka] + f * x[kb]
    raise ValueError(size)


def entries(R, adds, src, part, a, v="e-c5"):
    """be_ramp.entries, keeping the row (x) and a unit factor (1 main, 0.5 an add) instead of one size's return."""
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or r["date"] < a: continue
        if part != "all" and half(r["date"]) != part: continue
        x, m = r["v"][v], r["at"][v]
        w = SV.SIZEV[v](r.get("rvol", 0))
        E.append((r["date"], m, w, x, 1.0))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or v not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            aw = 0.5 * w
            aw = min(aw, max(0.0, 0.05 / 0.02 - w))   # the 5% position line at 2% (as be_ramp at 2%)
            if x.get("added"): aw = min(aw, max(0.0, w * (1 - x.get("share", 0))))
            if share > 0 and up is not None and up > 0 and aw > 1e-9: E.append((ad["date"], ad["minute"], aw, ad["v"][v], 0.5))
            break
    return sorted(E, key=lambda e: e[:2])


def account(E, pct, rule):
    """size_volume.account, the stake = pct x the rule's multiplier x w; the multiplier from the drop at the day's open."""
    by = collections.defaultdict(list)
    for e in E: by[e[0]].append(e)
    days = sorted(set(by) | {e[3]["h"]["exit_day"] or e[0] for e in E})
    eq, peak, dd, open_, prev, mult = 1e5, 1e5, 0.0, [], None, 1.0
    cut, n, usd = 0, 0, []
    for d in days:
        base = eq + sum(st * t[3]["h"]["marks"].get(prev, 0.0) * t[2] for st, t, _ in open_)
        down = 1 - base / peak
        for lvl, back, m in (rule or []):
            if down >= lvl: mult = min(mult, m)
        for lvl, back, m in reversed(rule or []):   # step back up once the drop is under the line
            if mult <= m and down < back: mult = 1.0 if m == rule[0][2] else rule[rule.index((lvl, back, m)) - 1][2]
        for e in by.get(d, []):
            size = pct * mult * e[4]
            r_ = max(-1, ret(e[3], size)) * e[2]   # an add: its half-size return, weight aw (already half), never halved again
            open_.append((pct * mult * base, e, r_)); n += 1; cut += mult < 1
            usd.append((1e4 * mult * r_, e[3][BR.SV.SIZES[0.02][0]] >= 3.0, mult))
        keep = []
        for st, t, r_ in open_:
            if (t[3]["h"]["exit_day"] or t[0]) == d: eq += st * r_
            else: keep.append((st, t, r_))
        open_ = keep
        now = eq + sum(st * t[3]["h"]["marks"].get(d, 0.0) * t[2] for st, t, _ in open_)
        peak = max(peak, now); dd = max(dd, 1 - now / peak); prev = d
    end = eq + sum(st * r_ for st, _, r_ in open_)
    return dict(acct=round(end), dd=round(dd, 3), trades=n, cut=cut, gcut=sum(1 for u, g, m in usd if g and m < 1),
                giants=sum(1 for u, g, m in usd if g))


def main():
    R, adds = pickle.load(open(f"{BR.B}/be_ramp_R.pkl", "rb"))
    out = {}
    for pct, flats in ((0.02, (0.02, 0.0175, 0.015)), (0.03, (0.03, 0.025, 0.0225))):
        print(f"\n### {pct:.0%} basic size, from $100,000 (e's trades, real quotes)\n")
        print("| Version | Part | Fair: end / worst drop | vs e | trades cut · giants cut | Favorites: end / worst drop | vs e | trades cut · giants cut |")
        print("|---|---|---|---|---|---|---|---|")
        for part in ("tune", "check", "all"):
            vs = [(f"e flat {f:.2%}", f, None) for f in flats] + [(f"{k} on {pct:.0%}", pct, RULES[k]) for k in RULES]
            for name, p, rule in vs:
                cells = []
                for src, a in (("fair", ""), ("fav", FR.A24)):
                    s = account(entries(R, adds, src, part, a), p, rule)
                    out[f"{pct}|{part}|{name}|{src}"] = s
                    b = out[f"{pct}|{part}|e flat {pct:.2%}|{src}"]
                    cells.append(f"${s['acct']:,} / {s['dd']:.1%} | {s['acct'] / b['acct']:.3f} | {s['cut']} of {s['trades']} · {s['gcut']} of {s['giants']}")
                print(f"| {name} | {part} | " + " | ".join(cells) + " |", flush=True)
    json.dump(out, open(f"{BR.B}/dd_base_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
