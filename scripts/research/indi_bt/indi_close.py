"""The Indi close: buy strong stocks at 15:57 for the night (the user, 2026-10-30: "take all indi speaking about over night
trades and try to gather ideas", then "Entry ... try 15:57", "never to the night of earnings", "if stock close above
it's all time high it's a good sign", "volume for be 1.3X+", "you can use also next day expiry. you can test both").

His trades (actions.csv, 2023-10 to 2026-10): +$11.15M of ~$12.8M came overnight, +$5.1M from entries after 15:00 held
for the night; his late overnight buys (median of 176): up 3.6% on the day (winners 2.9%, losers 4.2%), 92% of the
day's range, 1.2% above VWAP, stronger than SPY over the last hour, 1.6x day volume, ~5% OTM (winners 4.6%), 2-3 days,
mostly calls, fewer Fridays; out at the next open. His posts: close at the high on rising volume, ignore SPY's dips,
expect a gap and sell within 1-2 minutes without one.

A new strategy beside the champion. At 15:57 New York (minute 387), each stock of the fair list and the Favorites
(favorites.txt), on the bet's side (a put is the mirror):
  move    the day's move from the day before's close in [lo, hi]           range   in the top 15% of the day's range
  vwap    above the day's VWAP                                              rs60    the last 60 minutes' excess move vs
  vol     day volume to 15:57 >= 1.3x its median at 15:57 (20 sessions)            SPY x beta > 0
  no earnings tonight or tomorrow before the open (news_filter reactions: tomorrow is no reaction day); not a Friday
  at most 3 a night (the strongest last-hour moves first)
The option: delta `d` (0.20 thesis), the nearest expiry in the window (2-4 days, or tomorrow: 1), $0.20 and 200
contracts in the last 30 minutes; bought at 15:57, held overnight (the 10% cap at each size).
Exit ("his"): 09:31 New York, if the stock is not above the day before's close on the bet's side, half out, the rest
at 09:32 unless it is above by then; if it gapped our way, half at 09:31 and the rest at 10:00. "at10": all at 10:00.
Versions (set before running), each on both expiries (-w = 2-4 days, -n = tomorrow):
  thesis  move 2-4%, d 0.20, his exit        m15  move 1.5-4%        m3  move >= 3%
  d30     delta 0.30                         d15  delta 0.15         at10   all at 10:00
  ath     thesis + the close above the highest close in our data (bars since late 2022; not a true all-time high)
Every version on the tune weeks; the pick (min(fair, Favorites) money at 2%) on the check weeks, alone and with the
champion, in the same run. Also: of Indi's late overnight buys (15:00+, held overnight) how many the rule takes (same
date, stock and side). Real quotes: IC_PASS=list -> open11_dbx_list.csv (entry day and next day), dbx_fetch.py open11.

  node --env-file=.env <dir>/run.mjs indi_close.py (IC_PASS=list first, then dbx_fetch.py open11)   (from the app repo root)

IC_SET=rs (the user, 2026-10-30, after the run above: "we do not need the stock to be up. only strong against the spy and
on the top 90% of the day", then "strong with spy mean t>1.2 and D2 during the day bigger than 0.5 (not all day but
... check some permotaitons on tune)"): no move rule and no VWAP rule; the top 10% of the day's range (pos >= 0.90); the
volume (1.3x) and earnings rules stay; "strong" = the bot's t at 15:57 (defence_signals.py: the day's t-stat of the
stock's excess minute moves vs SPY x beta) >= T and its D2 (the excess on SPY-down minutes, in the stock's S30 units)
>= 0.5 over a window. Set before running, every T in (1.0, 1.2, 1.5) x every D2 window, each on both expiries:
  c30   D2 of the last 30 minutes at 15:57 (the bot's D2)       max30  the 30-minute D2 reached >= 0.5 at any minute today
  c120  D2 of the last 120 minutes at 15:57                     day    D2 of the whole day (the contrast to "not all day")
  plus t12-c30-d1 (D2 >= 1.0) and m3 (the earlier pick: move >= 3%, top 15%, VWAP, last hour > SPY) for reference.
The night's top 3 by t. Picked on tune by min(fair, Favorites) at 2%; only the pick on check.
Quotes: IC_PASS=list -> open12_dbx_list.csv, dbx_fetch.py open12.
"""
import bisect, collections, csv, datetime as dt, glob, gzip, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RR_ONLY"] = "roll"
import retry_roll as rr
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import news_filter as nf
import opt_spread as OS
import real_bench as RB
from low_delta import HIS40, PRIOR
from signals import beta
from levels import ctx
from split import half
from store import day

B = "data/local/x/bt"
SIZES = rr.SIZES
LISTING = os.environ.get("IC_PASS") == "list"
M_IN = 387
A0, Z = "2024-02-01", FR.Z
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open5", "open7", "open8", "open9", "open10", "open11", "open12", "open14")]
VOL = os.environ.get("IC_SET") == "vol"
RS = os.environ.get("IC_SET") == "rs" or VOL
TAG = "_vol" if VOL else ("_rs" if RS else "")
LIST_NAME = {"_vol": "open14_dbx_list.csv", "_rs": "open12_dbx_list.csv"}.get(TAG, "open11_dbx_list.csv")
BASE = dict(lo=0.02, hi=0.04, d=0.20, exit="his", ath=False, pos=0.85, vwap=True, rs="60", vol="min", fri=False)
CORE = {"thesis": {}, "m15": dict(lo=0.015), "m3": dict(lo=0.03, hi=9.0), "d30": dict(d=0.30), "d15": dict(d=0.15),
        "at10": dict(exit="at10"), "ath": dict(ath=True)}
if RS:
    ANY = dict(lo=-9.0, hi=9.0, pos=0.90, vwap=False, d2=0.5)
    CORE = {f"t{round(t * 10):02d}-{w}": {**ANY, "rs": "td", "t": t, "win2": w} for t in (1.0, 1.2, 1.5) for w in ("c30", "max30", "c120", "day")}
    CORE["t12-c30-d1"] = {**ANY, "rs": "td", "t": 1.2, "win2": "c30", "d2": 1.0}
    CORE["m3"] = dict(lo=0.03, hi=9.0)
VERSIONS = {f"{k}-{w}": {**BASE, **v, "win": (2, 4) if w == "w" else (1, 1)} for k, v in CORE.items() for w in ("w", "n")}
if VOL:
    # the user, 2026-10-30, after his_vol.py (his late giants had normal volume, his losers the most): "yes" to the volume
    # rule three ways (>= 1.3x as before / none / under 1.3x, strong but quiet) x Fridays out / in, next-day expiry (the
    # next trading day: Monday for a Friday), t 1.0 / 1.2 / 1.5 x the four D2 windows; range, earnings, top 3 as before
    VERSIONS = {f"t{round(t * 10):02d}-{w}-{vl}-{'fri' if fr else 'nofri'}": {**BASE, **ANY, "rs": "td", "t": t, "win2": w, "vol": vl, "fri": fr, "win": "next"}
                for t in (1.0, 1.2, 1.5) for w in ("c30", "c120", "max30", "day") for vl in ("min", "none", "max") for fr in (False, True)}
RX = None
BASE_EXPIRY = sim.expiry_for   # restored after each pick (set at import, so every worker has it)


def book(date):
    if date not in RB.Q:
        if len(RB.Q) > 3: RB.Q.clear()
        by = {}
        for d in [RB.DBX, fm.DBX["fair"], fm.DBX["fav"]] + EXTRAS:
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


def features(job):
    """The stock-day at 15:57 for both sides, or None."""
    src, sym, date = job
    i = rr.CAL.index(date)
    bars = day(sym, date); prev = day(sym, rr.CAL[i - 1])
    if len(bars) < 300 or not prev: return None
    b = {x[0]: x for x in bars}
    c = rr.closes(sym, date); spy = rr.closes("SPY", date)
    if not c[M_IN] or not c[M_IN - 60] or not spy[M_IN] or not spy[M_IN - 60]: return None
    pc = prev[-1][4]
    upto = [x for x in bars if x[0] <= M_IN]
    hi, lo = max(x[2] for x in upto), min(x[3] for x in upto)
    pv = sum((x[2] + x[3] + x[4]) / 3 * x[5] for x in upto); vol = sum(x[5] for x in upto)
    past = []
    for d in rr.CAL[max(0, i - 20):i]:
        v = sum(x[5] for x in day(sym, d) if x[0] <= M_IN)
        if v: past.append(v)
    if len(past) < 10: return None
    b_ = beta(sym, date, i, rr.CAL)
    if b_ is None: return None
    ex60 = (c[M_IN] / c[M_IN - 60] - 1) - b_ * (spy[M_IN] / spy[M_IN - 60] - 1)
    sp = day("SPY", rr.CAL[i - 1])
    if not sp: return None
    exday = (c[M_IN] / prev[-1][4] - 1) - b_ * (spy[M_IN] / sp[-1][4] - 1)
    cx = ctx(sym, date)
    if not cx or not cx["sd"]: return None
    td = tstrength(c, spy, b_, cx["sd"])
    if not td: return None
    return dict(src=src, sym=sym, date=date, px=c[M_IN], move=c[M_IN] / pc - 1, pos=(c[M_IN] - lo) / (hi - lo) if hi > lo else 0.5,
                vwap=c[M_IN] / (pv / vol) - 1 if vol else 0.0, ex60=ex60, exday=exday, **td, rvol=vol / st.median(past), pc=pc)


def tstrength(c, spy, b_, unit):
    """The bot's t and D2 at 15:57, both sides (defence_signals.py, unweighted): t over the day's minutes; D2 (the excess
    on SPY-down minutes for a call, minus the excess on SPY-up minutes for a put) over the last 30 / 120 minutes, the
    highest 30-minute D2 at any minute from 09:40, and the whole day."""
    n = s1 = s2 = 0.0
    ec, ep = [0.0] * 390, [0.0] * 390
    for m in range(1, M_IN + 1):
        if not (c[m] and c[m - 1] and spy[m] and spy[m - 1]): continue
        rs, rp = c[m] / c[m - 1] - 1, spy[m] / spy[m - 1] - 1
        x = rs - b_ * rp
        n += 1; s1 += x; s2 += x * x
        if rp < 0: ec[m] = x / unit
        if rp > 0: ep[m] = -x / unit
    if n < 30: return None
    mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
    t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
    out = dict(t=t)
    for side, e in (("c", ec), ("p", ep)):
        win = lambda a, z: sum(e[max(1, a):z + 1])
        out[f"{side}_c30"] = win(M_IN - 29, M_IN)
        out[f"{side}_c120"] = win(M_IN - 119, M_IN)
        out[f"{side}_day"] = win(1, M_IN)
        out[f"{side}_max30"] = max(win(m - 29, m) for m in range(10, M_IN + 1))
    return out


def ath_flags(rows):
    """The close above (call) / below (put) every earlier day's close in our bars, per stock (bars since late 2022)."""
    by = collections.defaultdict(list)
    for r in rows: by[r["sym"]].append(r)
    for sym, R in by.items():
        closes = {d: (day(sym, d) or [[0, 0, 0, 0, None]])[-1][4] for d in rr.CAL if d < max(r["date"] for r in R)}
        ds = sorted(d for d, v in closes.items() if v)
        for r in R:
            prior = [closes[d] for d in ds if d < r["date"]]
            r["ath"] = bool(prior) and r["px"] > max(prior)
            r["atl"] = bool(prior) and r["px"] < min(prior)


def candidates(rows, v):
    """Each night's picks under version v: (row, right), at most 3, the strongest last-hour move first."""
    global RX
    if RX is None: RX = nf.reactions()
    by = collections.defaultdict(list)
    for r in rows:
        if dt.date.fromisoformat(r["date"]).weekday() == 4 and not v["fri"]: continue
        i = rr.CAL.index(r["date"])
        if i + 1 < len(rr.CAL) and (i + 1) in set(RX.get(r["sym"], [])): continue   # tomorrow is its earnings reaction day
        for right, bet in (("C", 1), ("P", -1)):
            mv, pos, vw = bet * r["move"], r["pos"] if bet > 0 else 1 - r["pos"], bet * r["vwap"]
            e60, eday = bet * r["ex60"], bet * r["exday"]
            if v["rs"] == "td":
                strong = bet * r["t"] >= v["t"] and r[f"{'c' if bet > 0 else 'p'}_{v['win2']}"] >= v["d2"]
                ex = bet * r["t"]
            else:
                strong, ex = e60 > 0, e60
            if not (v["lo"] <= mv <= v["hi"] and pos >= v["pos"] and strong): continue
            if v["vol"] == "min" and r["rvol"] < 1.3: continue
            if v["vol"] == "max" and r["rvol"] >= 1.3: continue
            if v["vwap"] and vw <= 0: continue
            if v["ath"] and not (r["ath"] if bet > 0 else r["atl"]): continue
            by[(r["src"], r["date"])].append((ex, r, right))
    return {k: [(r, right) for _, r, right in sorted(x, key=lambda q: -q[0])[:3]] for k, x in by.items()}


def pick(r, right, d, win):
    exp = None
    d0 = dt.date.fromisoformat(r["date"])
    first = d0.replace(day=1); nxt = (first + dt.timedelta(days=32)).replace(day=1)
    exps = set()
    for m0 in (first, nxt):
        k = (r["sym"], m0.isoformat()[:7])
        if k not in sim._exp: sim._exp[k] = sim.expiries(r["sym"], m0.isoformat(), (m0 + dt.timedelta(days=40)).isoformat())
        exps |= set(sim._exp[k])
    if win == "next":   # the next trading day's expiry (Monday for a Friday)
        a = b = rr.CAL[rr.CAL.index(r["date"]) + 1]
    else:
        a, b = (d0 + dt.timedelta(days=win[0])).isoformat(), (d0 + dt.timedelta(days=win[1])).isoformat()
    exp = next((e for e in sorted(exps) if a <= e <= b), None)
    if not exp: return None
    call = right == "C"
    ks = [k for k in sim.chain(r["sym"], exp, right) if (r["px"] <= k <= r["px"] * (1 + sim.C["otm_scan_max"]) if call else r["px"] * (1 - sim.C["otm_scan_max"]) <= k <= r["px"])]
    ks = sorted(ks, key=lambda k: abs(k - r["px"]))[:sim.C["max_strikes"]]
    syms = [sim.occ(r["sym"], exp, k, right) for k in ks]
    if syms:
        try: sim.fetch_bars("options", syms, r["date"], r["date"], key=f"ic|{r['sym']}|{r['date']}|{right}|{exp}")
        except Exception: pass
    sim.expiry_for = lambda und, dd: exp
    try:
        cands = cu.candidates(r["sym"], r["date"], M_IN, right, r["px"])
    finally:
        sim.expiry_for = BASE_EXPIRY
    if not cands: return None
    best = min(cands, key=lambda x: abs(x[3] - d))
    if best[4] < (0.10 if r["sym"] == "IBIT" else 0.20) or best[5] < 200: return None
    return best[0], exp


def walk(job):
    """One trade: bought at 15:57, out next morning by the version's exit. -> results at each size."""
    src, r, right, d, win, exit_ = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    c = pick(r, right, d, win)
    if not c: return None
    i = rr.CAL.index(r["date"]); nd = rr.CAL[i + 1]
    if LISTING: return [(r["date"], c[0], M_IN - 2), (nd, c[0], 0)]
    try: sim.fetch_bars("options", [c[0]], r["date"], nd)
    except Exception: pass
    o0 = {x[0]: x for x in day(c[0], r["date"])}; o1 = {x[0]: x for x in day(c[0], nd)}
    buy = next((o0[m] for m in range(M_IN, M_IN - 6, -1) if m in o0), None)
    if not buy: return None
    oc = lambda m: next((o1[k][4] for k in range(m, -1, -1) if k in o1), None)
    sc = rr.closes(r["sym"], nd)
    bet = 1 if right == "C" else -1
    s = lambda m: next((sc[k] for k in range(m, -1, -1) if sc[k]), None)
    cost = buy[4]
    steps = [(r["date"], M_IN, "buy", 1.0, cost, "entry"), (r["date"], 389, "carry", 1.0, o0.get(389, buy)[4], "eod_carry")]
    if exit_ == "at10":
        p = oc(30)
        if p is None: return None
        steps.append((nd, 30, "sell", 1.0, p, "at10"))
    else:
        close0 = day(r["sym"], r["date"])[-1][4]   # the entry day's close: "yesterday's close" at the open
        up1 = s(1) is not None and bet * (s(1) / close0 - 1) > 0
        p1, p2, p30 = oc(1), oc(2), oc(30)
        if None in (p1, p2, p30): return None
        if up1:
            steps += [(nd, 1, "sell", 0.5, p1, "gap_half"), (nd, 30, "sell", 0.5, p30, "at10")]
        else:
            up2 = s(2) is not None and bet * (s(2) / close0 - 1) > 0
            steps.append((nd, 1, "sell", 0.5, p1, "no_gap_half"))
            if up2: steps.append((nd, 30, "sell", 0.5, p30, "at10"))
            else: steps.append((nd, 2, "sell", 0.5, p2, "no_gap_rest"))
    rcost, real = OS.price(steps, c[0], cost, "bid")
    return dict(src=src, date=r["date"], sym=r["sym"], right=right, contract=c[0], r={sz: sim.result(rcost, real, sz) for sz in SIZES},
                book=sum(bool(RB.quote(c[0], x[0], max(x[1] - 1, 0))) for x in real if x[2] in ("buy", "sell")) / max(1, sum(x[2] in ("buy", "sell") for x in real)))


def main():
    days = [d for d in rr.CAL if A0 <= d <= Z and rr.CAL.index(d) + 1 < len(rr.CAL)]
    jobs = [("fair", s, d) for d in days for s in sorted(HIS40) if s in PRIOR[d[:4]] and d <= RB.LAST]
    jobs += [("fav", s, d) for d in days if d >= FR.A24 for s in sorted(FR.FAV)]
    print(len(jobs), "stock-days", flush=True)
    with mp.Pool(8) as pool: rows = [x for x in pool.map(features, jobs, chunksize=50) if x]
    ath_flags(rows)
    print(len(rows), "with features", flush=True)
    picks = {v: candidates(rows, VERSIONS[v]) for v in VERSIONS}
    tj = {}
    for v, P in picks.items():
        V = VERSIONS[v]
        for (src, date), lst in P.items():
            for r, right in lst:
                tj[(src, date, r["sym"], right, V["d"], V["win"], V["exit"])] = (src, r, right, V["d"], V["win"], V["exit"])
    print(len(tj), "trades to walk", flush=True)
    ks = list(tj)
    with mp.Pool(8) as pool: W = dict(zip(ks, pool.map(walk, [tj[k] for k in ks], chunksize=2)))
    if LISTING:
        rowsq = sorted({x for w in W.values() if w for x in w})
        with open(os.path.join(HERE, LIST_NAME), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rowsq)
        print(f"{len(rowsq)} rows on {len({x[0] for x in rowsq})} days -> {LIST_NAME}"); return

    def trades(v, src, part):
        V = VERSIONS[v]; out = []
        for (s, date), lst in picks[v].items():
            if s != src or half(date) != part: continue
            for r, right in lst:
                w = W.get((src, date, r["sym"], right, V["d"], V["win"], V["exit"]))
                if w: out.append(w)
        return out

    def E(v, src, part, size): return [(w["date"], 389, 1.0, w["r"][size], 1) for w in trades(v, src, part)]
    # every trade of every version (the user, 2026-10-30: "lets focus from now the last 3 minutes trading ... I want to see
    # this benchmark") -> indi_close[_rs]_trades.json
    json.dump({f"{v}|{src}|{part}": [dict(date=w["date"], sym=w["sym"], right=w["right"], contract=w["contract"], r={str(k): x for k, x in w["r"].items()})
                                     for w in trades(v, src, part)] for v in VERSIONS for src in ("fair", "fav") for part in ("tune", "check")},
              open(f"{B}/indi_close{TAG}_trades.json", "w"))
    L = ("fair", "fav")
    out = {(s, "tune", v): [rr.stats(E(v, src, "tune", s), s) for src in L] for s in SIZES for v in VERSIONS}
    print("\n#### The Indi close alone, the tune weeks, every version (end / worst drop; $10K a trade: trades, winners, median, sum, giants, the rest)\n")
    print("| Version | Tune fair 2% | Tune fav 2% | Fair: n, win, median, sum, giants, rest | Fav: n, win, median, sum, giants, rest |\n|---|---|---|---|---|")
    def desc(T):
        u = [1e4 * max(-1, w["r"][0.02]) for w in T]; g = [x for x in u if x >= 3e4]
        return f"{len(u)}, {sum(x > 0 for x in u)}, {st.median(u) if u else 0:+,.0f}, {sum(u):+,.0f}, {len(g)}, {sum(u) - sum(g):+,.0f}"
    for v in VERSIONS:
        tf, tv = out[(0.02, "tune", v)]
        print(f"| {v} | ${tf['acct']:,} / {tf['dd']:.0%} | ${tv['acct']:,} / {tv['dd']:.0%} | {desc(trades(v, 'fair', 'tune'))} | {desc(trades(v, 'fav', 'tune'))} |", flush=True)
    best = max(VERSIONS, key=lambda v: min(out[(0.02, "tune", v)][i]["acct"] for i in (0, 1)))
    print(f"\nPicked on tune: {best} 🎯")
    for s in SIZES: out[(s, "check", best)] = [rr.stats(E(best, src, "check", s), s) for src in L]
    print(f"\n#### The pick on the check weeks\n\n| Size | Check fair | Check fav | Fair: n, win, median, sum, giants, rest | Fav: same |\n|---|---|---|---|---|")
    for s in SIZES:
        cf, cv = out[(s, "check", best)]
        print(f"| {s:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | {desc(trades(best, 'fair', 'check'))} | {desc(trades(best, 'fav', 'check'))} |", flush=True)
    # the champion + the pick (each trade at the size, the close trades on their entry day)
    champ = json.load(open(f"{B}/champ_entries.json")) if os.path.exists(f"{B}/champ_entries.json") else None
    if champ:
        print("\n#### The champion + the pick, 2% (the champion's own entries from champ_entries.json)\n\n| Half | List | Champion | + the Indi close |\n|---|---|---|---|")
        for part in ("tune", "check"):
            for src in L:
                C = [tuple(x) for x in champ[f"{src}|{part}|0.02"]]
                a, b2 = rr.stats(C, 0.02), rr.stats(C + E(best, src, part, 0.02), 0.02)
                print(f"| {part} | {src} | ${a['acct']:,} / {a['dd']:.0%} | ${b2['acct']:,} / {b2['dd']:.0%} |", flush=True)
    # Indi's late overnight buys the rule would take (same date, stock, side)
    A = []
    for f in glob.glob("data/local/x/ultrawavetrader-20*/actions.csv"): A += [a for a in csv.DictReader(open(f)) if a["account"] == "silexx"]
    byt = collections.defaultdict(list)
    for a in A: byt[a["trade"]].append(a)
    late = set()
    for k, v in byt.items():
        v.sort(key=lambda a: (a["date"], a["time_from"] or "99"))
        if (v[0]["time_from"] or "") >= "15:00" and len({a["date"] for a in v}) > 1:
            late.add((v[0]["date"], v[0]["contract"].split()[0], v[0]["contract"].split()[-1][-1]))
    took = {(d, r["sym"], right) for (s, d), lst in picks[best].items() for r, right in lst}
    inlists = {x for x in late if x[1] in HIS40 or x[1] in FR.FAV}
    print(f"\nIndi's late overnight buys: {len(late)} ({len(inlists)} on our lists' stocks); the pick takes {len(took & inlists)} of them; the pick's nights {len(took)}")
    bk = [w["book"] for w in W.values() if w]
    print(f"fills on the real book: {sum(bk) / max(1, len(bk)):.0%} of {len(bk)}")
    json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in out.items()}, open(f"{B}/indi_close{TAG}_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
