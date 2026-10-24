"""V2: a separate 0DTE strategy, the user's spec (2026-10-24): breakouts first, with lower strength / volume
thresholds; the champion's stop first; always take profit; no entry after 13:00 New York (20:00 Israel).

Entry (signal minute 10-209, so the buy fills by 13:00 New York; same-day expiry only, sim.py skips a day without one):
  a breakout = a close at least 0.25 S30 beyond a level (S30 as in levels.py: a typical 30-minute move), crossing it
  that minute (the close before was not that far beyond). Kinds:
    prev   yesterday's high (call) / low (put)
    five   the 5-day high / low
    or15   the first 15 minutes' high / low (from minute 15)
    day    the day's high / low so far (from minute 15)
    any    the first of these
  confirmed at that minute by the C measures (t-stat of 1-minute moves vs SPY x beta our way, day volume vs normal):
    c0  t >= 0,   volume >= 1.0x     (breakout alone, moving our way)
    c1  t >= 1.0, volume >= 1.2x
    c2  t >= 1.5, volume >= 1.5x     (near the champion's, for reference)
  one signal per stock, day and rule: the first. The news filter applies (no earnings reaction day, pre-market < 4x).
Contract: same-day expiry, delta 0.15 / 0.20 / 0.25 (the user's range), the champion's price and volume minimums.
Exits, all with the champion's stop first (+10 / +20 minute checks with the stock against, -30% with the stock against)
and out by 15:30 New York (expiry day):
  S        the stop only (reference: no take profit)
  T30      all at +30%
  T50      all at +50%
  T100     all at +100%
  H50_100  half at +50%, the rest at +100%
  THIRDS   a third at +50%, a third at +100%, the rest trails 30% under its high
Fills at the next bar's middle +/- 2%, commission per contract. 1% of the start-of-day account from $100,000.

  node --env-file=.env <path>/run.mjs zero4.py run        (from the repo root) -> data/local/x/bt/z4_results.json
  python3 <path>/zero4.py summary
"""
import collections, csv, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("BT_UNIVERSE", "wide")
import sim
from store import P, day, calendar
from signals import series, beta
from tiers_round import H
from levels import ctx, BREAK

B = "data/local/x/bt"
OUT = f"{B}/z4_results.json"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
FIRST, LAST = 10, 209
KINDS = ("prev", "five", "or15", "day", "any")
CONFIRM = {"c0": (0.0, 1.0), "c1": (1.0, 1.2), "c2": (1.5, 1.5)}
DELTAS = (0.15, 0.20, 0.25)
X0 = {**sim.X, **H}
EXITS = {
    "S": {},
    "T30": dict(takes=[[0.3, 1.0]]),
    "T50": dict(takes=[[0.5, 1.0]]),
    "T100": dict(takes=[[1.0, 1.0]]),
    "H50_100": dict(takes=[[0.5, 0.5], [1.0, 0.5]]),
    "THIRDS": dict(takes=[[0.5, 1 / 3], [1.0, 1 / 3]], trail=0.3),
}
sim.C.update(dte_min=0, dte_max=0)  # same-day expiry only
CAL = calendar()
IDX = {d: i for i, d in enumerate(CAL)}


def stock(sym):
    """-> signals [{date, sym, right, minute, rules: [kind|confirm, ...]}] for one stock."""
    out = []
    for i, date in enumerate(CAL):
        if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
        if not sim.expiry_for(sym, date) == date: continue  # no same-day expiry: nothing to buy
        x = ctx(sym, date)
        if x is None: continue
        b_ = beta(sym, date, i, CAL)
        if b_ is None: continue
        hist = []
        for d in CAL[i - 20:i]:
            v = [0] * 390
            for bar in day(sym, d): v[bar[0]] = bar[5]
            acc, cum = 0, []
            for q in v: acc += q; cum.append(acc)
            if cum[-1] > 0: hist.append(cum)
        if len(hist) < 10: continue
        c = x["c"]; spy = series(day("SPY", date))[0]
        vol = [0] * 390
        for bar in day(sym, date): vol[bar[0]] = bar[5]
        cum, acc = [], 0
        for q in vol: acc += q; cum.append(acc)
        n = s1 = s2 = 0.0
        found = {}
        for m in range(1, LAST + 1):
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                r = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
                n += 1; s1 += r; s2 += r * r
            if m < FIRST or c[m] is None or n < 10: continue
            prev_c = next((c[j] for j in range(m - 1, -1, -1) if c[j]), None)
            if prev_c is None: continue
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
            med = sorted(hh[m] for hh in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            rv = cum[m] / usual if usual else 0.0
            hs = [v for v in x["h"][:m] if v]; ls = [v for v in x["l"][:m] if v]
            lv = {"prev": (x["prev_hi"], x["prev_lo"]), "five": (x["p5_hi"], x["p5_lo"])}
            if m >= 15 and any(x["h"][:15]):
                lv["or15"] = (max(v for v in x["h"][:15] if v), min(v for v in x["l"][:15] if v))
                if hs: lv["day"] = (max(hs), min(ls))
            margin = BREAK * x["sd"] * c[m]
            for kind, (hi, lo) in lv.items():
                for right, bet, level in (("C", 1, hi), ("P", -1, lo)):
                    now = bet * (c[m] - level) >= margin
                    before = bet * (prev_c - level) >= margin
                    if not now or before: continue
                    tt = bet * t
                    for cname, (need_t, need_v) in CONFIRM.items():
                        if tt < need_t or rv < need_v: continue
                        for kk in (kind, "any"):
                            rule = f"{kk}|{cname}"
                            if rule not in found: found[rule] = (m, right)
        for rule, (m, right) in found.items():
            out.append((date, sym, m, right, rule))
    return out


def walk(sig):
    """One signal at both deltas, every exit: -> {(delta, exit): ret or None}, contract info."""
    date, sym, m, right = sig
    res = {}
    spot = day(sym, date)
    px = next((b[4] for b in spot if b[0] == m), None)
    if px is None: return sig, res
    seen = {}
    for d in DELTAS:
        sim.C.update(dte_min=0, dte_max=0, delta=d)
        best, why = sim.pick(sym, date, m, right, px)
        if best is None: res[str(d)] = why; continue
        con, exp = best[0], best[1]
        if con in seen:  # two deltas picked the same contract
            for name in EXITS: res[f"{d}|{name}"] = res[f"{seen[con]}|{name}"]
            continue
        seen[con] = d
        for name, ex in EXITS.items():
            sim.X.clear(); sim.X.update(X0); sim.X.update(ex)
            cost, steps, _ = sim.walk(sym, date, m, right, con, exp, CAL)
            res[f"{d}|{name}"] = None if cost is None else round(sim.result(cost, steps), 4)
    return sig, res


def run():
    with mp.Pool(8) as pool: parts = pool.map(stock, P["universe"])
    S = collections.defaultdict(list)
    for p in parts:
        for date, sym, m, right, rule in p: S[(date, sym, m, right)].append(rule)
    print(len(S), "distinct signals", flush=True)
    done = json.load(open(OUT)) if os.path.exists(OUT) else {}
    todo = [k for k in S if "|".join(map(str, k)) not in done]
    with mp.Pool(8) as pool:
        for i, (sig, res) in enumerate(pool.imap_unordered(walk, todo, chunksize=4)):
            done["|".join(map(str, sig))] = dict(rules=S[sig], res=res)
            if i % 500 == 0:
                print(i, "/", len(todo), flush=True); json.dump(done, open(OUT, "w"))
    for k in S: done["|".join(map(str, k))]["rules"] = S[k]
    json.dump(done, open(OUT, "w")); print("done", flush=True)


def factor(r, f):
    """A strategy's value of one factor: the breakout kind, the confirmation, the delta or the exit."""
    kind, cname = r["rule"].split("|")
    if f == "kind": return kind
    if f == "confirm": return cname
    return r[f]


def summary():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    from score_sum import account
    D = json.load(open(OUT))
    T = []
    for k, v in D.items():
        date, sym, m, right = k.split("|")
        T.append(dict(date=date, sym=sym, minute=m, right=right, rules=v["rules"], res=v["res"]))
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    T.sort(key=lambda t: (t["date"], int(t["minute"])))
    lists = {"fair": lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]], "unseen": lambda t: t["sym"] not in HIS40}
    rows = []
    for kind in KINDS:
        for cname in CONFIRM:
            rule = f"{kind}|{cname}"
            for d in DELTAS:
                for ex in EXITS:
                    key = f"{d}|{ex}"
                    r = dict(rule=rule, delta=d, exit=ex)
                    for ln, lf in lists.items():
                        L = [t for t in T if rule in t["rules"] and lf(t) and isinstance(t["res"].get(key), float)]
                        pn = [dict(date=t["date"], pnl=str(1e4 * max(-1, t["res"][key]))) for t in L]
                        rets = sorted(t["res"][key] for t in L)
                        eq, dd = account(pn) if pn else (1e5, 0)
                        best5 = set(id(x) for x in sorted(pn, key=lambda x: -float(x["pnl"]))[:5])
                        eq5, _ = account([x for x in pn if id(x) not in best5]) if pn else (1e5, 0)
                        yr = {y: [1e4 * max(-1, t["res"][key]) for t in L if t["date"][:4] == y] for y in SPAN}
                        r[ln] = dict(n=len(L), win=sum(x > 0 for x in rets) / max(1, len(rets)), end=eq, dd=dd, wo5=eq5,
                                     yr={y: (len(v), sum(v) / max(1, len(v))) for y, v in yr.items()})
                    rows.append(r)
    json.dump(rows, open(f"{B}/z4_summary.json", "w"))
    steady = [r for r in rows if all(r[l]["yr"][y][1] > 0 and r[l]["yr"][y][0] > 0 for l in lists for y in SPAN)]
    fmt = lambda r, l: f"{r[l]['n']} / {100 * r[l]['win']:.0f}% / ${r[l]['end']:,.0f} / {100 * r[l]['dd']:.0f}% / wo5 ${r[l]['wo5']:,.0f} / " + " ".join(f"{v[1]:+,.0f}" for v in r[l]["yr"].values())
    print(f"{len(rows)} strategies; positive every year on both lists: {len(steady)}")
    print("\n## Top 20 by the fair list (trades / winners / account at 1% / worst drop / without best 5 / per trade 2024 2025 2026)")
    for r in sorted(rows, key=lambda r: -r["fair"]["end"])[:20]:
        print(f"{r['rule']:12} d{r['delta']} {r['exit']:8} | fair {fmt(r, 'fair')} | unseen {fmt(r, 'unseen')}")
    print("\n## Positive every year on both lists")
    for r in sorted(steady, key=lambda r: -(r["fair"]["end"] + r["unseen"]["end"])):
        print(f"{r['rule']:12} d{r['delta']} {r['exit']:8} | fair {fmt(r, 'fair')} | unseen {fmt(r, 'unseen')}")
    print("\n## Median fair / unseen end by factor")
    for f, vals in (("kind", KINDS), ("confirm", tuple(CONFIRM)), ("delta", DELTAS), ("exit", tuple(EXITS))):
        for v in vals:
            sel = [r for r in rows if factor(r, f) == v]
            print(f"{f} {v}: fair ${st.median(r['fair']['end'] for r in sel):,.0f}, unseen ${st.median(r['unseen']['end'] for r in sel):,.0f}")


if __name__ == "__main__":
    run() if sys.argv[1:] == ["run"] else summary()
