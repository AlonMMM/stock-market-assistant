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

IC_SET=many ("nightly-bet", the user, 2026-10-31: "lets try to make a lot more trading. I want that almost every night
we'll take a 2 bets"): rank, not a bar. Each night the stock-sides that pass the version's filters are ranked by the
bot's t at 15:57 and the best N are bought. Set before running (all: no earnings night, next-day expiry, his exit):
  t18-top3  t >= 1.8, top 10% of range, volume 1.3x, no Friday, top 3 (= tonly-t18, the reference)
  t18-top2  the same, top 2                         r2-v13  best 2 by t, no t floor, top 10%, volume 1.3x
  r2        best 2 by t, top 10%, no volume rule    r2-p80  r2 with the top 20% of the range
  r2-fri    r2 + Fridays (Monday expiry)            r2-t10  r2 with t >= 1.0
Picked on tune among the r2* versions by min(fair, Favorites) at 2%; the pick and the reference on check. Also: the
share of trading nights with 2 bets. Quotes: IC_PASS=list -> open22_dbx_list.csv, dbx_fetch.py open22.

IC_SET=fill (nightly-bet, the user 2026-10-31 "go." after nb_why.py: of each night's ranked candidates 70% have no
next-day expiry and 17% a thin one, and IC_SET=many stopped at the top 2): go down the ranking until 2 bets trade, and
when a stock has no liquid next-day option take the nearest liquid expiry 1-4 calendar days out ("fb"). Set before running:
  t18-top3     the reference (tonly-t18: next-day only, top 3, no fill)
  r2v13-down   best 2 by t, volume 1.3x, down the list, next-day only (the fill alone)
  t18-fill     t >= 1.8, volume 1.3x, down the list + the 1-4 day fallback
  r2v13-fill   best 2 by t, volume 1.3x, down the list + fallback
  r2-fill      best 2 by t, no volume rule, down the list + fallback
Picked on tune among the *-fill / -down versions; the pick and the reference on check; nights with 2 bets by weekday.
Quotes: IC_PASS=list -> open23_dbx_list.csv (only the bets each night takes), dbx_fetch.py open23.
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
import d3 as D3
from split import half
from store import day

B = "data/local/x/bt"
SIZES = rr.SIZES
LISTING = os.environ.get("IC_PASS") == "list"
M_IN = 387
A0, Z = "2024-02-01", FR.Z
EXTRAS = [os.path.join(HERE, "dbx_cache", x) for x in ("open2", "open3", "open4", "open5", "open7", "open8", "open9", "open10", "open11", "open12", "open14", "open15", "open16", "open22", "open23")]
VOL = os.environ.get("IC_SET") == "vol"
D2B = os.environ.get("IC_SET") == "d2b"
D3S = os.environ.get("IC_SET") == "d3"
FILL = os.environ.get("IC_SET") == "fill"
MANY = os.environ.get("IC_SET") == "many" or FILL
RS = os.environ.get("IC_SET") == "rs" or VOL or D2B or D3S or MANY
TAG = {"vol": "_vol", "d2b": "_d2b", "rs": "_rs", "d3": "_d3", "many": "_many", "fill": "_fill"}.get(os.environ.get("IC_SET"), "")
LIST_NAME = {"_vol": "open14_dbx_list.csv", "_d2b": "open15_dbx_list.csv", "_rs": "open12_dbx_list.csv", "_d3": "open16_dbx_list.csv", "_many": "open22_dbx_list.csv", "_fill": "open23_dbx_list.csv"}.get(TAG, "open11_dbx_list.csv")
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
if D2B:
    # the user, 2026-10-30: "D2 is not a constrain - it's a bonus, or it's come alone". Strong = t >= T, or:
    #   alone  D2 over the window >= X with no t needed (X 1.0 / 2.0)
    #   bonus  t >= 0.8 and D2 >= 0.5 (the bot's bonus entry)
    #   tonly  no D2 path (the reference)
    # T 1.2 / 1.5 / 1.8, window the last 30 min / the last 2 hours; volume >= 1.3x, range, earnings, no Friday, top 3 by t,
    # next-day expiry (the next trading day), as before
    D2V = {}
    for t in (1.2, 1.5, 1.8):
        D2V[f"tonly-t{round(t * 10)}"] = {**BASE, **ANY, "rs": "tor", "t": t, "win2": "c30", "alone": None, "bonus": False, "win": "next"}
        for w in ("c30", "c120"):
            for x in (1.0, 2.0):
                D2V[f"alone-t{round(t * 10)}-{w}-x{round(x * 10)}"] = {**BASE, **ANY, "rs": "tor", "t": t, "win2": w, "alone": x, "bonus": False, "win": "next"}
            D2V[f"bonus-t{round(t * 10)}-{w}"] = {**BASE, **ANY, "rs": "tor", "t": t, "win2": w, "alone": None, "bonus": True, "win": "next"}
    VERSIONS = D2V
if D3S:
    # the user, 2026-10-30 "Go" (after d3.py / d3_check.py: D3-last >= 0.5 on 74% of his late winners vs 58% of his losers):
    # D3 (all of today's SPY swings) or D3-last (the latest swing) as a bonus (t >= 1.8, or t >= 0.8 and D3 >= X), alone
    # (t >= 1.8, or D3 >= X with no t), or in place of D2 (t >= T and D3 >= 0.5); t >= 1.8 alone as the reference.
    # Volume 1.3x, top 10% of range, no earnings, no Friday, next-day expiry, top 3 by t, as before.
    D3V = {"tonly-t18": {**BASE, **ANY, "rs": "d3", "t": 1.8, "k3": "d3", "x3": None, "tlow": None, "win": "next"}}
    for k in ("d3", "d3_last"):
        for x in (0.5, 1.0):
            D3V[f"bonus-{k}-x{round(x * 10)}"] = {**BASE, **ANY, "rs": "d3", "t": 1.8, "k3": k, "x3": x, "tlow": 0.8, "win": "next"}
            D3V[f"alone-{k}-x{round(x * 10)}"] = {**BASE, **ANY, "rs": "d3", "t": 1.8, "k3": k, "x3": x, "tlow": -99, "win": "next"}
        for t in (1.0, 1.2, 1.5):
            D3V[f"and-{k}-t{round(t * 10)}"] = {**BASE, **ANY, "rs": "d3and", "t": t, "k3": k, "x3": 0.5, "win": "next"}
    VERSIONS = D3V
if MANY:
    R = {**BASE, **ANY, "rs": "rank", "win": "next", "win2": "c30"}
    VERSIONS = {"t18-top3": {**R, "t": 1.8, "n": 3}, "t18-top2": {**R, "t": 1.8, "n": 2},
                "r2-v13": {**R, "t": -99, "n": 2}, "r2": {**R, "t": -99, "n": 2, "vol": "none"},
                "r2-p80": {**R, "t": -99, "n": 2, "vol": "none", "pos": 0.80}, "r2-fri": {**R, "t": -99, "n": 2, "vol": "none", "fri": True},
                "r2-t10": {**R, "t": 1.0, "n": 2, "vol": "none"}}
if FILL:
    VERSIONS = {"t18-top3": {**R, "t": 1.8, "n": 3},
                "r2v13-down": {**R, "t": -99, "n": 2, "fill": True},
                "t18-fill": {**R, "t": 1.8, "n": 2, "fill": True, "win": "fb"},
                "r2v13-fill": {**R, "t": -99, "n": 2, "fill": True, "win": "fb"},
                "r2-fill": {**R, "t": -99, "n": 2, "fill": True, "win": "fb", "vol": "none"}}
REF = "t18-top3" if MANY else None
PICKABLE = [v for v in VERSIONS if v != "t18-top3" and (v.startswith("r2") or FILL)] if MANY else list(VERSIONS)
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
    if D3S:   # D3 only where the range and volume rules can pass (it reads 20 sessions)
        pos_ = (c[M_IN] - lo) / (hi - lo) if hi > lo else 0.5
        for side, ok in (("C", pos_ >= 0.9), ("P", pos_ <= 0.1)):
            x = D3.d3(sym, date, M_IN, side) if ok and vol / st.median(past) >= 1.3 else None
            td[f"{side}_d3"] = x["d3"] if x else None
            td[f"{side}_d3_last"] = x["d3_last"] if x else None
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
            if v["rs"] in ("d3", "d3and"):
                tt, x3 = bet * r["t"], r.get(f"{right}_{v['k3']}")
                if v["rs"] == "d3and": strong = tt >= v["t"] and x3 is not None and x3 >= v["x3"]
                else: strong = tt >= v["t"] or (v["x3"] is not None and x3 is not None and tt >= v["tlow"] and x3 >= v["x3"])
                ex = tt
            elif v["rs"] == "rank":
                tt = bet * r["t"]; strong = tt >= v["t"]; ex = tt
            elif v["rs"] == "tor":
                tt, e2 = bet * r["t"], r[f"{'c' if bet > 0 else 'p'}_{v['win2']}"]
                strong = tt >= v["t"] or (v["alone"] is not None and e2 >= v["alone"]) or (v["bonus"] and tt >= 0.8 and e2 >= 0.5)
                ex = tt
            elif v["rs"] == "td":
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
    return {k: [(r, right) for _, r, right in sorted(x, key=lambda q: -q[0])[:99 if v.get("fill") else v.get("n", 3)]] for k, x in by.items()}


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
    elif win != "fb":
        a, b = (d0 + dt.timedelta(days=win[0])).isoformat(), (d0 + dt.timedelta(days=win[1])).isoformat()
    if win == "fb":   # the next trading day's expiry if it is liquid, else the nearest liquid one 1-4 calendar days out
        nd = rr.CAL[rr.CAL.index(r["date"]) + 1]
        for e in sorted(e for e in exps if nd <= e <= (d0 + dt.timedelta(days=4)).isoformat()):
            got = pick_exp(r, right, d, e)
            if got: return got
        return None
    exp = next((e for e in sorted(exps) if a <= e <= b), None)
    if not exp: return None
    return pick_exp(r, right, d, exp)


def pick_exp(r, right, d, exp):
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

    def taken(v, src, date, lst):   # the night's bets: the top N, or (fill) the first N down the ranking that trade
        V = VERSIONS[v]; out = []
        for r, right in lst:
            w = W.get((src, date, r["sym"], right, V["d"], V["win"], V["exit"]))
            if w: out.append(w)
            if V.get("fill") and len(out) >= V["n"]: break
        return out
    if LISTING:
        rowsq = sorted({x for v in VERSIONS for (src, date), lst in picks[v].items() for w in taken(v, src, date, lst) for x in w})
        with open(os.path.join(HERE, LIST_NAME), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rowsq)
        print(f"{len(rowsq)} rows on {len({x[0] for x in rowsq})} days -> {LIST_NAME}"); return

    def trades(v, src, part):
        out = []
        for (s, date), lst in picks[v].items():
            if s != src or half(date) != part: continue
            out += taken(v, src, date, lst)
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
    if MANY:   # nights with 2+ bets: of the trading nights each list could trade (Fridays count only where allowed)
        print("\n#### Nights with bets (tune weeks): share of nights with 0 / 1 / 2+ walked trades\n\n| Version | Fair | Fav |\n|---|---|---|")
        for v in VERSIONS:
            cells = []
            for src in L:
                nights = [d for d in days if half(d) == "tune" and (src == "fair" or d >= FR.A24) and d <= RB.LAST
                          and (VERSIONS[v]["fri"] or dt.date.fromisoformat(d).weekday() != 4)]
                cnt = collections.Counter(w["date"] for w in trades(v, src, "tune"))
                k = [min(cnt.get(d, 0), 2) for d in nights]
                cells.append(f"{len(nights)} nights: {k.count(0) / len(k):.0%} / {k.count(1) / len(k):.0%} / {k.count(2) / len(k):.0%}")
            print(f"| {v} | {cells[0]} | {cells[1]} |", flush=True)
        print("\n#### Nights with 2 bets by weekday, fair list, all weeks (Mon / Tue / Wed / Thu / Fri)\n\n| Version | Mon | Tue | Wed | Thu | Fri |\n|---|---|---|---|---|---|")
        for v in VERSIONS:
            cnt = collections.Counter(w["date"] for part in ("tune", "check") for w in trades(v, "fair", part))
            cells = []
            for wd in range(5):
                nights = [d for d in days if d <= RB.LAST and dt.date.fromisoformat(d).weekday() == wd]
                cells.append(f"{sum(cnt.get(d, 0) >= 2 for d in nights) / max(1, len(nights)):.0%}" if VERSIONS[v]["fri"] or wd != 4 else "-")
            print(f"| {v} | {' | '.join(cells)} |", flush=True)
    best = max(PICKABLE, key=lambda v: min(out[(0.02, "tune", v)][i]["acct"] for i in (0, 1)))
    print(f"\nPicked on tune: {best} 🎯")
    for vv in [best] + ([REF] if REF else []):
        for s in SIZES: out[(s, "check", vv)] = [rr.stats(E(vv, src, "check", s), s) for src in L]
        print(f"\n#### {vv} on the check weeks\n\n| Size | Check fair | Check fav | Fair: n, win, median, sum, giants, rest | Fav: same |\n|---|---|---|---|---|")
        for s in SIZES:
            cf, cv = out[(s, "check", vv)]
            print(f"| {s:.0%} | ${cf['acct']:,} / {cf['dd']:.0%} | ${cv['acct']:,} / {cv['dd']:.0%} | {desc(trades(vv, 'fair', 'check'))} | {desc(trades(vv, 'fav', 'check'))} |", flush=True)
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
