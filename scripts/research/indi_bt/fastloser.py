"""What at the entry tells the fast losers from the trades that hold (the user, 2026-10-31: "so you can't find anyway to
drop the drop with smal-mid los of money where the rick-rewered stay?" then "do it"; the next step logged by runup.py
2026-10-29: the champion's trades sold out by 20 minutes are 37% of its trades, never a giant, median -$3.2K, -$630-660K
a half, while every giant was still full at 20 minutes).

On the champion's entries, picks and exits (d2_failed_break.CHAMP, real quotes, the pyramid; walk as runup.py). Label:
a main leg is a fast loser when the 10 / 20-minute checks and stops have sold all of it by 20 minutes after the entry.
Features at the entry minute, on the bet's side (a put is the mirror), all known then:
  t, v, d2, d2e        the signal row's t, day volume vs usual, D2 (c_d) and c_e
  pre_rvol, pre_gap    the signal row's pre-market volume and gap (the gap his way)
  run                  the stock's last-10-minute move in typical 30-minute moves (runup.py)
  pos                  the price in the day's range so far, 1 = at the extreme his way
  minute               minutes after 09:30
  spy_day, spy10       SPY from the day before's close / over the last 10 minutes, his way
  opt_px, iv, vol30, delta   the picked contract's price, IV, 30-minute volume and delta
  spread               the picked contract's ask - bid over the mid at the entry minute (real quotes)
  nday                 champion entries already taken that day on the same list, before this one
  d2entry              the entry came on the D2 bonus (t < 1.8)
Diagnostic, tune and check apart: per feature, quintiles (cut points from the tune weeks): trades, fast-loser share,
giants, median, sum without the giants.
Rules, set before running: half size (the main leg and its add) when a feature is in its bottom / top tune quintile
(2 x 16 versions; d2entry: half on D2 entries / on the others). Each version is scored against the smaller-size line:
the champion at a flat 1% / 1.5% / 2%, its end value read at the version's worst drop (linear between the points);
score = the version's end / that line, the min of fair and Favorites, at 2%. One pick on tune (🎯); only the pick and
the flat line run on the check weeks. Tune = even entry weeks, check = odd (split.py), in the same run.

  node --env-file=.env <dir>/run.mjs fastloser.py      (from the app repo root)
-> data/local/x/bt/fastloser_summary.json, fastloser_trades.csv
"""
import collections, csv, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import real_bench as RB
from levels import ctx
from runup import walk_at
from score_sum import account
from split import half
from store import calendar, day

B = "data/local/x/bt"
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
FEATS = ["t", "v", "d2", "d2e", "pre_rvol", "pre_gap", "run", "pos", "minute", "spy_day", "spy10", "opt_px", "iv", "vol30",
         "delta", "spread", "nday"]
FLAT = {0.01: ("r1", "r05"), 0.015: ("r15", "r1"), 0.02: ("r2", "r1")}   # the add of a 1.5% trade uses the 1% cap (approx.)
fnum = lambda x: None if x in (None, "", "None") else float(x)


def closes(sym, date):
    c = [None] * 390
    for b in day(sym, date):
        if 0 <= b[0] < 390: c[b[0]] = b[4]
    for m in range(1, 390):
        if c[m] is None: c[m] = c[m - 1]
    return c


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"]); bet = 1 if t["right"] == "C" else -1
    base = walk_at(t, m0, float(t["price"]))
    if base is None: return None
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], d2entry=int(float(t.get("c_t") or 9) < 1.8),
               v_=base)
    if kind == "add": return out
    f = dict(t=fnum(t.get("c_t")), v=fnum(t.get("c_rvol")), d2=fnum(t.get("c_d")), d2e=fnum(t.get("c_e")), pre_rvol=fnum(t.get("pre_rvol")),
             pre_gap=None if fnum(t.get("pre_gap")) is None else bet * fnum(t.get("pre_gap")), minute=m0)
    cx = ctx(t["sym"], t["date"])
    f["run"] = f["pos"] = None
    if cx and cx["sd"] and cx["c"][m0]:
        if m0 >= 10 and cx["c"][m0 - 10]: f["run"] = bet * math.log(cx["c"][m0] / cx["c"][m0 - 10]) / cx["sd"]
        hs = [x for x in cx["h"][:m0 + 1] if x]; ls = [x for x in cx["l"][:m0 + 1] if x]
        if hs and max(hs) > min(ls):
            p = (cx["c"][m0] - min(ls)) / (max(hs) - min(ls)); f["pos"] = p if bet > 0 else 1 - p
    s = closes("SPY", t["date"]); i = IDX.get(t["date"])
    sp = day("SPY", CAL[i - 1]) if i else None
    f["spy_day"] = bet * (s[m0] / sp[-1][4] - 1) if sp and s[m0] else None
    f["spy10"] = bet * (s[m0] / s[m0 - 10] - 1) if m0 >= 10 and s[m0] and s[m0 - 10] else None
    cands = cu.candidates(t["sym"], t["date"], m0, t["right"], float(t["price"]))
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    f["opt_px"] = f["iv"] = f["vol30"] = f["delta"] = f["spread"] = None
    if p:
        c = p[0]; f["opt_px"], f["vol30"], f["iv"], f["delta"] = c[4], c[5], c[6], abs(c[3])
        q = RB.quote(c[0], t["date"], m0)
        if q and q[0] and q[1] and q[1] >= q[0]: f["spread"] = (q[1] - q[0]) / ((q[0] + q[1]) / 2)
    out.update(f)
    return out


def adds_of(R):
    A = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": A[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    return A


def scaled(h, k):
    """score_sum.held of a leg (runup.walk_at's h), its marks at k times the size (as its pnl)."""
    return dict(h, marks={d: k * x for d, x in h["marks"].items()})


def entries(R, A, src, part, size, flag=lambda r: False, a=""):
    """(date, minute, share, ret, over, held) for the account; a flagged main leg (and its add) at half size."""
    full, halfk = FLAT[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        x, m = r["v_"], r["minute"]
        k = 0.5 if flag(r) else 1.0
        # at half size the night cap binds as for a trade of half the size
        E.append((r["date"], m, k, x[halfk] if k < 1 else x[full], x["over"], scaled(x["h"], k)))
        if not r["d2entry"]: continue
        for ad in sorted(A.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0:
                E.append((ad["date"], ad["minute"], 0.5 * k, ad["v_"]["r05" if k < 1 else halfk], ad["v_"]["over"],
                          scaled(ad["v_"]["h"], 0.5 * k)))
            break
    return E


def stats(E, size):
    R = sorted(E, key=lambda e: e[:5])
    usd = [1e4 * e[2] * max(-1, e[3]) for e in R]
    pnl = [dict(date=e[0], pnl=str(u), **e[5]) for e, u in zip(R, usd)]
    acct, dd = account(pnl, size)
    top = sorted(range(len(R)), key=lambda i: -usd[i])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in set(top[:5])], size)
    years = collections.defaultdict(float)
    for e, u in zip(R, usd): years[e[0][:4]] += u
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), years={y: round(x) for y, x in sorted(years.items())})


def line_at(pts, dd):
    """The flat line's end value at a worst drop dd (pts: [(dd, acct)] sorted by dd), linear, extended at the ends."""
    pts = sorted(pts)
    for (d0, a0), (d1, a1) in zip(pts, pts[1:]):
        if dd <= d1 or (d1, a1) == pts[-1]:
            return a0 + (a1 - a0) * (dd - d0) / (d1 - d0) if d1 != d0 else a1
    return pts[-1][1]


def quint(xs):
    xs = sorted(x for x in xs if x is not None)
    return [xs[int(len(xs) * q)] for q in (0.2, 0.4, 0.6, 0.8)] if len(xs) >= 25 else None


def bucket(x, cuts):
    if x is None or cuts is None: return None
    return sum(x >= c for c in cuts)


def group(rows):
    usd = [1e4 * max(-1, r["v_"]["r1"]) for r in rows]
    g = [u for r, u in zip(rows, usd) if r["v_"]["r1"] >= 3.0]
    return dict(n=len(rows), fast=round(sum(r["v_"]["path"] == "out by 20" for r in rows) / max(1, len(rows)), 3), giants=len(g),
                median=round(st.median(usd)) if usd else 0, nongiant=round(sum(usd) - sum(g)))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    R = [r for r in R if r["kind"] == "add" or r["src"] != "fav" or r["date"] >= FR.A24]
    M = sorted((r for r in R if r["kind"] == "main"), key=lambda r: (r["src"], r["date"], r["minute"]))
    seen = collections.Counter()
    for r in M:
        r["nday"] = seen[(r["src"], r["date"])]; seen[(r["src"], r["date"])] += 1
    A = adds_of(R)
    out = {}
    with open(f"{B}/fastloser_trades.csv", "w") as fh:
        w = csv.writer(fh); w.writerow(["src", "half", "date", "minute", "sym", "right", "d2entry", "path", "ret_1pct", *FEATS])
        for r in M: w.writerow([r["src"], half(r["date"]), r["date"], r["minute"], r["sym"], r["right"], r["d2entry"], r["v_"]["path"],
                                round(r["v_"]["r1"], 4), *[r.get(k) for k in FEATS]])
    tune = [r for r in M if half(r["date"]) == "tune"]
    cuts = {k: quint([r.get(k) for r in tune]) for k in FEATS}
    out["cuts"] = cuts
    # diagnostic
    print("\n### Which entries are the fast losers (sold out by 20 minutes): quintiles, cut points from tune, main legs at $10K\n")
    print("| Feature | Half | List | Q1 (low) fast / giants / median | Q2 | Q3 | Q4 | Q5 (high) | Spread of fast share Q1-Q5 |\n|---|---|---|---|---|---|---|---|---|")
    for k in FEATS + ["d2entry"]:
        for part in ("tune", "check"):
            for src in ("fair", "fav"):
                rows = [r for r in M if half(r["date"]) == part and r["src"] == src]
                if k == "d2entry": by = {0: [r for r in rows if not r["d2entry"]], 1: [r for r in rows if r["d2entry"]]}
                else:
                    by = collections.defaultdict(list)
                    for r in rows:
                        b = bucket(r.get(k), cuts[k])
                        if b is not None: by[b].append(r)
                G = {b: group(v) for b, v in by.items()}
                out[f"diag|{k}|{part}|{src}"] = G
                cells = [f"{G[b]['fast']:.0%} / {G[b]['giants']} / {G[b]['median']:+,} ({G[b]['n']})" if b in G else "-" for b in range(5 if k != "d2entry" else 2)]
                fs = [G[b]["fast"] for b in G]
                print(f"| {k} | {part} | {src} | {' | '.join(cells + [''] * (5 - len(cells)))} | {max(fs) - min(fs):.0%} |" if fs else "", flush=True)
    base_fast = {(p, s): group([r for r in M if half(r["date"]) == p and r["src"] == s]) for p in ("tune", "check") for s in ("fair", "fav")}
    out["all"] = {f"{p}|{s}": g for (p, s), g in base_fast.items()}
    print("\nAll main legs:", {f"{p} {s}": f"fast {g['fast']:.0%}, giants {g['giants']}, median {g['median']:+,}, non-giant {g['nongiant']:+,}" for (p, s), g in base_fast.items()})
    # rules
    V = {}
    for k in FEATS:
        if not cuts[k]: continue
        V[f"{k}-low"] = (lambda k: lambda r: r.get(k) is not None and r[k] < cuts[k][0])(k)
        V[f"{k}-high"] = (lambda k: lambda r: r.get(k) is not None and r[k] >= cuts[k][3])(k)
    V["d2entry-half"] = lambda r: r["d2entry"] == 1
    V["signal-half"] = lambda r: r["d2entry"] == 0

    def run(part, names):
        res = {}
        for src in ("fair", "fav"):
            for size in FLAT: res[f"flat|{src}|{size}"] = stats(entries(R, A, src, part, size), size)
            for n in names: res[f"{n}|{src}"] = stats(entries(R, A, src, part, 0.02, V[n]), 0.02)
        score = {}
        for n in names:
            sc = []
            for src in ("fair", "fav"):
                pts = [(res[f"flat|{src}|{z}"]["dd"], res[f"flat|{src}|{z}"]["acct"]) for z in FLAT]
                s = res[f"{n}|{src}"]; s["line"] = round(line_at(pts, s["dd"])); s["score"] = round(s["acct"] / s["line"], 3)
                sc.append(s["score"])
            score[n] = min(sc)
        return res, score

    def show(part, res, names, picks=()):
        print(f"\n### {part} weeks, real quotes, from $100,000: the flat line and the half-size rules (at 2%)\n")
        print("| Version | List | Trades | End / worst drop | The flat line at that drop | vs the line | Without the best 5 | By year |\n|---|---|---|---|---|---|---|---|")
        for src in ("fair", "fav"):
            for z in FLAT:
                s = res[f"flat|{src}|{z}"]
                print(f"| flat {z:.1%} | {src} | {s['trades']} | ${s['acct']:,} / {s['dd']:.0%} | - | - | ${s['no5']:,} | {' · '.join(f'{y} {x:+,}' for y, x in s['years'].items())} |")
            for n in names:
                s = res[f"{n}|{src}"]
                print(f"| {n}{' 🎯' if n in picks else ''} | {src} | {s['trades']} | ${s['acct']:,} / {s['dd']:.0%} | ${s['line']:,} | {s['score']:.3f} | ${s['no5']:,} | {' · '.join(f'{y} {x:+,}' for y, x in s['years'].items())} |", flush=True)

    res, score = run("tune", list(V))
    best = max(V, key=lambda n: score[n])
    show("Tune (even)", res, list(V), [best])
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs the flat line at the same drop, 2%): {best} ({score[best]:.3f}); beats the line on both: {score[best] > 1}")
    out["tune"] = res; out["pick"] = best
    res2, score2 = run("check", [best])
    show("Check (odd), the same run: the flat line and the pick", res2, [best], [best])
    print(f"\nCheck: {best} vs the flat line {score2[best]:.3f}")
    out["check"] = res2
    json.dump(out, open(f"{B}/fastloser_summary.json", "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
