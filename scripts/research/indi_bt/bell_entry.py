"""09:35 with the pre-market in the calculation (the user, 2026-10-28: "On the bell with pre market calc?", then "I meant 5
min from openning").

At 09:35 New York (minute 5), the champion's rule on the pre-market (08:00-09:29, premarket_d2.py's table prem) and the
first five minutes as one series: t = the t-stat of the stock's 1-minute excess moves vs SPY x beta (beta of the 20
sessions before) over every minute both traded; D2 = the excess on SPY's bad minutes of the last 30 of them, in S30
units; the volume = the day's volume to 09:35 over its median at 09:35 of the 20 sessions before. A call when t >= T
with the volume >= 1.5x, or t >= 1.2 and D2 >= 1.5 (the D2 bonus); a put on the mirror; the news filter (no earnings
reaction day, pre-market volume under 4x). Bought at 09:35 (the option picked there, 200 contracts in its first five
minutes); a stock-day without it keeps the champion's entry (from 09:40). Set before running: T 1.8 (pre18) and 2.2
(pre22); and bell18, the pre-market alone (premarket_d2.signal(): t, D2 and the pre-market volume 1.5x-4x from 08:00-09:29,
t >= 1.8 or the D2 bonus), also bought at 09:35 (the user: "Sorry you wrre right"). The plain 09:35 start without the pre-market is entry_start.py f05. One run, tune AND check (split.py), fair
list + Favorites 24m, 2% and 3%. Real quotes: BE_PASS=list -> open4_dbx_list.csv, dbx_fetch.py open4 -> dbx_cache/open4.

  node --env-file=.env <dir>/run.mjs bell_entry.py (BE_PASS=list first, then dbx_fetch.py open4)   (from the app repo root)
"""
import collections, csv, glob, gzip, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import news_filter as nf
import real_bench as RB
from low_delta import HIS40, PRIOR
from split import half

B = "data/local/x/bt"
SIZES = rr.SIZES
LEVELS = ("bell18", "pre18", "pre22")
# bell18-fb (2026-10-28, after bell18 won with a small set of changed trades): when the 09:35 entry finds no contract,
# the stock-day keeps the champion's entry, as a live bot would; bell18 drops the day
LISTING = os.environ.get("BE_PASS") == "list"
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4")]
import math
import premarket_d2 as pd
from store import day


def book(date):
    """real_bench.book over the list's cache and the extra fetches."""
    if date not in RB.Q:
        if len(RB.Q) > 3: RB.Q.clear()
        by = {}
        for d in [RB.DBX] + EXTRAS:
            path = os.path.join(d, f"{date}.csv.gz")
            if not os.path.exists(path): continue
            got = {}
            for r in csv.DictReader(gzip.open(path, "rt")):
                if r["bid"] and r["ask"] and float(r["ask"]) > 0 and float(r["bid"]) > 0:
                    got.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
            for k, v in got.items(): by.setdefault(k, sorted(v))
        RB.Q[date] = by
    return RB.Q[date]


RB.book = book
Z = FR.Z
FAV = sorted({t["sym"] for t in FR.signals("25")} | {t["sym"] for t in FR.signals("24")})


def pre_state(job):
    """The stock-day at 09:35: t, D2 (a call / a put) and the volume ratio over the pre-market and the first 5 minutes."""
    sym, date = job
    i = rr.CAL.index(date)
    b_ = pd.beta(sym, date, i, rr.CAL); cx = pd.ctx(sym, date)
    if b_ is None or not cx or not cx["sd"]: return None
    reg, spyr = rr.closes(sym, date), rr.closes("SPY", date)
    c = pd.prem(sym, date) + list(reg[:6]); spy = pd.prem("SPY", date) + list(spyr[:6])
    n = s1 = s2 = 0.0; xs = []
    for m in range(1, len(c)):
        if None in (c[m], c[m - 1], spy[m], spy[m - 1]): continue
        rp = spy[m] / spy[m - 1] - 1; x = (c[m] / c[m - 1] - 1) - b_ * rp
        n += 1; s1 += x; s2 += x * x; xs.append((m, rp, x))
    if n < 10: return None
    var = max(s2 / n - (s1 / n) ** 2, 0.0)
    t = (s1 / n) / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
    last = len(c) - 30
    dc = sum(x / cx["sd"] for m, rp, x in xs if m >= last and rp < 0)
    dp = sum(-x / cx["sd"] for m, rp, x in xs if m >= last and rp > 0)
    cum = lambda d: sum(b[5] for b in day(sym, d) if b[0] <= 5)
    past = sorted(v for v in (cum(d) for d in rr.CAL[i - 20:i]) if v)
    rv = cum(date) / past[len(past) // 2] if len(past) >= 10 and past[len(past) // 2] else 0.0
    out = dict(sym=sym, date=date, t=round(t, 2), d2c=round(dc, 2), d2p=round(dp, 2), rv=round(rv, 2))
    pm = pd.signal(job)   # the pre-market alone
    if pm: out.update(pt=pm["t"], pd2c=pm["d2c"], pd2p=pm["d2p"], prv=pm["rv"])
    return out


PRE = None


def sum_signals(level):
    """The pre-market signals of a level, bought at 09:35: (fair, Favorites)."""
    global PRE
    if PRE is None:
        days = sorted({(s, d) for d in rr.CAL if "2024-02-01" <= d <= Z for s in set(HIS40) | set(FAV)})
        with mp.Pool(8) as pool: PRE = [x for x in pool.map(pre_state, days, chunksize=40) if x]
        for x in PRE: x["right"] = "C"
        nf.features(PRE)
        PRE = [x for x in PRE if x["e_next"] != 0 and (x["pre_rvol"] is None or x["pre_rvol"] < 4)]
        print(f"{len(PRE)} stock-days with no earnings reaction and pre-market volume under 4x", flush=True)
    T = 2.2 if level == "pre22" else 1.8
    out = []
    for x in PRE:
        side = None
        if level == "bell18":   # the pre-market alone: its own volume 1.5-4x
            if "pt" not in x or not (1.5 <= x["prv"] < 4): continue
            t_, dc_, dp_ = x["pt"], x["pd2c"], x["pd2p"]
        else:
            if x["rv"] < 1.5: continue
            t_, dc_, dp_ = x["t"], x["d2c"], x["d2p"]
        if t_ >= T or (t_ >= 1.2 and dc_ >= 1.5): side, tt = "C", t_
        elif -t_ >= T or (-t_ >= 1.2 and dp_ >= 1.5): side, tt = "P", -t_
        if not side: continue
        bars = day(x["sym"], x["date"])
        px = next((b[4] for b in reversed(bars) if 2 <= b[0] <= pd.PICK_MIN), None) if bars else None
        if px is None: continue
        out.append(dict(date=x["date"], sym=x["sym"], right=side, minute="5", price=px, c_t=str(round(tt, 2)), status="ok"))
    fair = [t for t in out if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST]
    fav = [t for t in out if t["sym"] in FAV and FR.A24 <= t["date"] <= Z]
    return fair, fav


def walk(job):
    src, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = rr.pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    if LISTING: return (date, c[0], max(m0 - 2, 0))
    g = rr.leg(sym, date, m0, right, c)
    if not g: return None
    rcost, real, book = g
    sells = [s for s in real if s[2] == "sell"]
    held = {}
    for mm in range(m0, 390):
        k = RB.quote(c[0], date, mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return dict(src=src, date=date, sym=sym, right=right, minute=m0, d2=int(float(t.get("c_t") or 9) < 1.8),
                r={s: sim.result(rcost, real, s) for s in SIZES}, h={s: sim.result(rcost, real, s / 2) for s in SIZES},
                over=int(any(s[0] != date for s in sells)), held=held, book=book)


def key(src, t): return (src, t["date"], t["sym"], t["right"], int(t["minute"]))


def main():
    base = {"fair": fe.fair_signals("sg_c12_15"), "fav": FR.signals("25")}
    adds = {"fair": fe.fair_signals("s_t18r15"), "fav": FR.signals("24")}
    sums = {lv: dict(zip(("fair", "fav"), sum_signals(lv))) for lv in LEVELS}
    # the versions' mains: (src, date, sym) -> the signal row
    V = {"base": {src: {(t["date"], t["sym"]): t for t in base[src]} for src in base}}
    for lv in LEVELS:   # the pre-market entry replaces that stock-day's champion entry; every other day as the champion
        V[lv] = {src: dict(V["base"][src]) for src in base}
        for src in base:
            for t in sums[lv][src]: V[lv][src][(t["date"], t["sym"])] = t
    for src in base:
        for lv in LEVELS:
            same = sum(1 for k, t in V[lv][src].items() if k in V["base"][src] and int(t["minute"]) == int(V["base"][src][k]["minute"]) and t["right"] == V["base"][src][k]["right"])
            print(f"{src} first minute {lv}: {len(V[lv][src])} stock-days vs the champion's {len(V['base'][src])}; the same day, side and minute: {same}", flush=True)
    jobs = {}
    for v in V.values():
        for src, d in v.items():
            for t in d.values(): jobs[key(src, t)] = (src, t)
    for src in adds:
        for t in adds[src]: jobs[("add",) + key(src, t)] = (src, t)
    print(len(jobs), "walks", flush=True)
    FB = "bell18-fb"
    ks = list(jobs)
    if LISTING:
        ks = [k for k in ks if k[0] != "add"]
        with mp.Pool(8) as pool: rows = sorted({x for x in pool.map(walk, [jobs[k] for k in ks], chunksize=4) if x})
        with open(os.path.join(HERE, "open4_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        print(f"{len(rows)} contracts on {len({x[0] for x in rows})} days -> open4_dbx_list.csv"); return
    with mp.Pool(8) as pool: W = dict(zip(ks, pool.map(walk, [jobs[k] for k in ks], chunksize=4)))
    V[FB] = {src: {k: (t if W.get(key(src, t)) or k not in V["base"][src] else V["base"][src][k]) for k, t in V["bell18"][src].items()} for src in base}
    for src in base:   # the days bell18 drops: a 09:35 signal with no contract, where the champion traded later
        dropped = [W.get(key(src, V["base"][src][k])) for k, t in V["bell18"][src].items()
                   if half(k[0]) == "tune" and k in V["base"][src] and not W.get(key(src, t)) and W.get(key(src, V["base"][src][k]))]
        print(f"bell18 {src} tune: {len(dropped)} champion trades dropped (no contract at 09:35); their sum at $10K {1e4 * sum(max(-1, x['r'][0.02]) for x in dropped):+,.0f}, "
              f"winners {sum(x['r'][0.02] > 0 for x in dropped)}", flush=True)
    A = collections.defaultdict(list)
    for k, w in W.items():
        if k[0] == "add" and w: A[(w["src"], w["date"], w["sym"], w["right"])].append(w)

    def entries(v, src, part, size, a=""):
        E = []
        for (date, sym), t in V[v][src].items():
            if half(date) != part or date < a: continue
            x = W.get(key(src, t))
            if not x: continue
            E.append((date, x["minute"], 1.0, x["r"][size], x["over"]))
            if not x["d2"]: continue
            for ad in sorted(A.get((src, date, sym, x["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= x["minute"]: continue
                share, up = x["held"].get(ad["minute"], (0, None))
                if share > 0 and up is not None and up > 0: E.append((date, ad["minute"], 0.5, ad["h"][size], ad["over"]))
                break
        return E

    L = (("fair", ""), ("fav", FR.A24))
    out = {(s, p, v): [rr.stats(entries(v, src, p, s, a), s) for src, a in L] for s in SIZES for p in ("tune", "check") for v in V}
    for size in SIZES:
        print(f"\n#### {size:.0%}, tune and check side by side (end / worst drop; without the best 5)\n\n| Version | Tune fair | Tune fav | Check fair | Check fav | "
              f"Without best 5, tune (fair / fav) | Without best 5, check (fair / fav) | Trades tune (fair / fav) |\n|---|---|---|---|---|---|---|---|")
        for v in V:
            (tf, tv), (cf, cv) = out[(size, "tune", v)], out[(size, "check", v)]
            print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | "
                  f"${tf['no5']:,} / ${tv['no5']:,} | ${cf['no5']:,} / ${cv['no5']:,} | {tf['trades']} / {tv['trades']} |", flush=True)
    b = out[(0.02, "tune", "base")]
    sc = lambda v: min(out[(0.02, "tune", v)][i]["acct"] / b[i]["acct"] for i in (0, 1))
    best = max((v for v in V if v != "base"), key=sc)
    bc, pc = out[(0.02, "check", "base")], out[(0.02, "check", best)]
    print(f"\nPicked on tune: {best} 🎯 (min of the lists vs the champion at 2%: {sc(best):.2f}). Check at 2%: fair ${pc[0]['acct']:,} vs ${bc[0]['acct']:,}; "
          f"Favorites ${pc[1]['acct']:,} vs ${bc[1]['acct']:,}; without the best 5 ${pc[0]['no5']:,} / ${pc[1]['no5']:,} vs ${bc[0]['no5']:,} / ${bc[1]['no5']:,}")
    # the entries that moved: the stock-days both trade, by when each version entered (tune, $10K a trade)
    for lv in LEVELS:
        for src in ("fair", "fav"):
            both = [(W.get(key(src, t)), W.get(key(src, V["base"][src][k]))) for k, t in V[lv][src].items() if half(k[0]) == "tune" and k in V["base"][src]]
            both = [(x, y) for x, y in both if x and y]
            moved = [(x, y) for x, y in both if x["minute"] != y["minute"] or x["right"] != y["right"]]
            new = [W.get(key(src, t)) for k, t in V[lv][src].items() if half(k[0]) == "tune" and k not in V["base"][src]]
            new = [x for x in new if x]
            bk = [x["book"] for x, _ in moved] + [x["book"] for x in new]
            print(f"{lv} {src} tune: {len(moved)} entries at another minute, {1e4 * sum(x['r'][0.02] for x, _ in moved):+,.0f} vs the champion's "
                  f"{1e4 * sum(y['r'][0.02] for _, y in moved):+,.0f}; {len(new)} stock-days the champion does not trade, {1e4 * sum(max(-1, x['r'][0.02]) for x in new):+,.0f}"
                  f" (book {sum(bk) / max(1, len(bk)):.0%})", flush=True)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/bell_entry_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
