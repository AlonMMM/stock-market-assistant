"""A late window that resets the day's signals, and an overnight hold for late trades that are not winners, on the
champion 2.10 (the user, 2026-11-06: "reset the signals we filter on 1 hour before the close or half an hour before the
close, and then allow the bots to re-enter a new trade, even if the stocked was signaled, which today is filtered and we
won't trade. Also, we can let the bot go overnight even if it's not a winner, if it's traded in the last hour or last
half an hour ... we can go like with a stock that lose like 5 or 10%, like Indy does"; on the volume: "the whole day
volume is not necessarily an enter", "volume from the old day is not necessarily from the night").

From the window's start to 15:44 a stock may take one late trade, whatever happened to it earlier today (2.10 traded it
and closed, or skipped it as too cheap / thin): the first minute where the champion's strength holds (t >= 1.8, or the
D2 bonus t >= 1.2 and D2 >= 1.5; defence_signals.py BT_LATE=330 -> s_late_<year>.csv), the volume rule passes and the
champion's pick passes (the 0.15 strike, 200 contracts in 30 minutes, $0.20; IBIT $0.10); a pick that fails is tried
again at the next late minute. No late trade while a 2.10 position in the stock is still open at that minute, when
2.10's own signal is already in the window (that trade is the late trade), or on a Friday (2.10 holds nothing over a
weekend, so a late trade there has no night). A late trade, and 2.10's own trades entered in the window, take 2.10's
exits until 15:50, then are held overnight when the option is at or above the carry level (the day-range rule of the
carry is off for them); the next morning 2.10's exits. Size: 2.10's tiers on the day volume ratio; the pyramid as 2.10.
Set before running:
  champ          2.10 as is (thin_strike.py's champ)
  <vol><win>-<carry>
    vol    n  no volume rule (strength only);  r  the last 30 minutes' volume >= 1.25x the usual of those 30 minutes
           (vol_flip.py's r30-125 level)
    win    15 = from 15:00;  30 = from 15:30
    carry  5 = at or above -5%;  10 = at or above -10%;  a = any (2.10's stops until 15:50 only)
Lists: the fair list + the Favorites (24 months); the fair list's filters on the late rows too (no earnings reaction
day, pre-market volume under 4x). Tune = even entry weeks, check = odd, the same run; one pick on tune by min(fair,
Favorites) vs champ at 2%; every version's check shown, the verdict on the pick. Look 1 on the Main bot (priors:
sig_lasthour.py 2026-11-01, the day's signals bought at 15:57; retry_skip.py 2026-11-05; on the Volume bot
late_carry.py 2026-10-28, late alerts carried overnight lost in every slice).
Real quotes: LR_PASS=list writes the late legs with no book at their entry minute -> open39_dbx_list.csv.

  node --env-file=.env <dir>/run.mjs late_reset.py      (from the app repo root; defence_signals.py BT_LATE=330 BT_LATE_ALL=1
  BT_SIG_SUFFIX=_t12 first: every late minute with t >= 1.2, the earlier versions keep their own rows rule)
-> data/local/x/bt/late_reset_summary.json, late_reset_legs.csv
"""
import collections, csv, datetime as dt, glob, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import thin_strike as TS   # 2.10's exits and walk, the tables
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import news_filter as nf
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from low_delta import HIS40, PRIOR
from score_sum import held as booked
from split import half
from signals import series, beta
from store import day

B = "data/local/x/bt"
LISTING = os.environ.get("LR_PASS") == "list"
WINS = {"15": 330, "30": 360}
CARRY = {"5": -0.05, "10": -0.10, "a": -1.0}
VOLS = ("n", "r")
MODES = ("champ",) + tuple(f"{v}{w}-{c}" for v in VOLS for w in WINS for c in CARRY)
# -nm (the user, 2026-11-06: "remove the morning exit for these trade"): no morning sale the day after the late entry
# (2.10 sells half on a gap our way, all on a gap against); the whole position stays under the day's stops
MODES += ("n30-a-nm", "r30-5-nm", "r30-10-nm", "r30-a-nm")
# -nf (the user, 2026-11-06: "run it without the 3 filters: contract too cheap, thin, and busy pre"): the late trades
# only, no $0.20 floor (any price > 0), no 200-contract rule, and no pre-market volume 4x filter (2.10's own legs as they are)
MODES += ("r30-a-nf", "r30-a-nm-nf")
# L versions (the user, 2026-11-06: "we should have t> 1.5, and t must be more than 1.2 in the last 3 hours, or increase
# hard on the last hour. also - we should be on the top (low) 0.9 or more on the stock; removing the busy days filter;
# the T must be flat or increaing - if it dropped exit"): from 15:30 to 15:44 with r30's volume (last 30 minutes >= 1.25x
# usual): t >= 1.5, and t >= 1.2 every minute of the 3 hours before or t up `hard` over the last hour; the stock at >= `rp`
# of the day's range so far on the bet's side (a call near the high, a put near the low); busy pre-market days allowed
# (the $0.20 floor and 200 contracts stay); held overnight always, 2.10's morning sale; on the entry day all out once t is
# `drop` under its t at the entry (sim.py thesis.t set per trade).
#   L<hard x10><rp x10>-a-<exit>: x = 2.10's own t exit only (0.5); d15 / d30 = out 0.15 / 0.3 under the entry's t
LMODES = ("L109-a-x", "L109-a-d15", "L109-a-d30", "L059-a-d30", "L108-a-d30")
MODES += LMODES
NO_MORNING = {"gap_keep": -1e9, "gap_sell_share": 0.0}   # the morning rule then sells 0 (the 0-share step is dropped)
LAST = 374   # 15:44
_pick = TS.pick


def pick(cands, floor, mode, und, right, spot):
    """Every version picks as the champion (the adds too)."""
    return _pick(cands, floor, "champ", und, right, spot)


TS.pick = pick
TS.MODES = MODES


def floor_of(sym):
    return 0.10 if sym == "IBIT" else 0.20


def champ_pick(sym, date, m, right, spot, free=False):
    """2.10's 0.15 pick; free: no floor and no 30-minute volume rule (any price over 0)."""
    cands = cu.candidates(sym, date, m, right, spot)
    if not cands: return None
    b = min(cands, key=lambda c: abs(c[3] - 0.15))
    if free: return b if b[4] > 0 else None
    if b[4] < floor_of(sym) or b[5] < 200: return None
    return b


def walk_carry(t, m, c, gain, nm=False, th=None):
    """thin_strike.walk_c with the night held from `gain` and no day-range rule; nm: no morning sale; th: the entry day's
    t exit level (sim.py thesis.t: all out once the bet's t is at or under it)."""
    over = {"carry_min_gain": gain, "carry_range_pos": 0.0, **(NO_MORNING if nm else {})}
    if th is not None: over["thesis"] = {**CHAMP["thesis"], "t": th}
    sim.X.clear(); sim.X.update(CHAMP); sim.X.update(over)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], TS.CAL)
    if cost is None: return None
    rcost, real = OS.price(nonzero(steps), c[0], cost, "bid")
    sim.X.clear(); sim.X.update(CHAMP); sim.X.update(over)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], TS.CAL, paid=rcost)
    if cost is None: return None
    steps = nonzero(steps)
    rcost, real = OS.price(steps, c[0], cost, "bid")
    row = dict(r1=sim.result(rcost, real, 0.01), r2=sim.result(rcost, real, 0.02), r3=sim.result(rcost, real, 0.03),
               r15=sim.result(rcost, real, 0.015), over=int(any(s[2] == "carry" for s in steps)), h=booked(rcost, real))
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    row["held"] = {}
    for mm in range(m, 390):
        k = RB.quote(c[0], t["date"], mm)
        row["held"][mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return row


def nonzero(steps):
    return [s for s in steps if not (s[2] == "sell" and s[3] <= 1e-9)]


def carry_of(mode):
    """-> (the carry level's key, no morning sale)"""
    p = mode.split("-")
    return p[1], "nm" in p[2:]


def nofilter(mode):
    return "nf" in mode.split("-")[2:]


def win_of(mode):
    if mode.startswith("L"): return WINS["30"]
    return WINS[mode[1:3]]


def drop_of(mode):
    """The L versions' t drop that exits (None: 2.10's t exit only)."""
    last = mode.split("-")[-1]
    if mode.startswith("L") and last.startswith("d"): return int(last[1:]) / 100
    return None


def tseries(sym, date):
    """The bot's t (minute excess vs beta x SPY since the open, a t-stat) for minutes 0..389, None before 10 steps."""
    i = TS.CAL.index(date)
    b_ = beta(sym, date, i, TS.CAL)
    c, s = series(day(sym, date))[0], series(day("SPY", date))[0]
    out, n, s1, s2 = [None] * 390, 0, 0.0, 0.0
    if b_ is None: return out
    for m in range(1, 390):
        if c[m] and c[m - 1] and s[m] and s[m - 1]:
            x = c[m] / c[m - 1] - 1 - b_ * (s[m] / s[m - 1] - 1)
            n += 1; s1 += x; s2 += x * x
        if n >= 10:
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            out[m] = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
    return out


def range_pos(sym, date, m, bet):
    """Where the stock closes minute m in the day's range so far, on the bet's side (1 = at the high for a call)."""
    bars = [b for b in day(sym, date) if b[0] <= m]
    if not bars: return 0.0
    hi, lo = max(b[2] for b in bars), min(b[3] for b in bars)
    if hi <= lo: return 0.0
    pos = (bars[-1][4] - lo) / (hi - lo)
    return pos if bet > 0 else 1 - pos


def dbx(src):
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()


def walk_main(job):
    """A 2.10 main signal: its walk, and for one entered in a window the walks at each carry level."""
    src, t = job
    dbx(src)
    m0, spot = int(t["minute"]), float(t["price"])
    b = champ_pick(t["sym"], t["date"], m0, t["right"], spot)
    if not b: return None
    base = TS.walk_c(t, m0, b)
    if base is None: return None
    v, by_c = {}, {}
    for mode in MODES:
        if mode == "champ" or m0 < win_of(mode): v[mode] = base; continue
        c = carry_of(mode)
        if c not in by_c: by_c[c] = walk_carry(t, m0, b, CARRY[c[0]], c[1])
        if by_c[c] is not None: v[mode] = by_c[c]
    info = dict(contract=b[0], strike=b[2], delta=round(abs(b[3]), 3), price=b[4], vol30=b[5], how="champ")
    return dict(src=src, kind="main", date=t["date"], minute=m0, sym=t["sym"], right=t["right"], late=False,
                d2=int(float(t.get("c_t") or 9) < 1.8), rvol=float(t.get("c_rvol") or 0), v=v, pick={m: info for m in v})


def late_rows():
    rows = [r for f in sorted(glob.glob(f"{B}/s_late_t12_20*.csv")) for r in csv.DictReader(open(f))]   # every t >= 1.2 (BT_LATE_ALL)
    for r in rows:
        r["minute"] = int(r["minute"])
        r["old"] = float(r["c_t"]) >= 1.8 or (float(r["c_t"]) >= 1.2 and float(r["c_e"]) >= 1.5)   # the earlier versions' rows
    nf.features(rows)
    out = []
    for r in rows:
        if r["e_next"] == 0 or r["date"] > RB.LAST: continue
        r["busy_pre"] = r["pre_rvol"] is not None and r["pre_rvol"] >= 4   # only the -nf versions trade these
        if dt.date.fromisoformat(r["date"]).weekday() == 4: continue
        if r["sym"] in HIS40 and r["sym"] in PRIOR[r["date"][:4]]: out.append(("fair", r))
        if r["sym"] in FR.FAV and FR.A24 <= r["date"] <= FR.Z: out.append(("fav", r))
    return out


def find_late(job):
    """One stock-day: for each (vol, win) the first late minute that trades. -> {(vol, win): (row, candidate)}"""
    (src, sym, date), rows, champ = job
    dbx(src)
    got, tried = {}, {}
    for vol in VOLS:
        for w, m1 in WINS.items():
            for free in (False, True):
                if free and (vol, w) != ("r", "30"): continue
                if any(c["minute"] >= m1 for c in champ): continue   # 2.10's own signal is the late trade
                for r in rows:
                    m = r["minute"]
                    if m < m1 or m > LAST or not r["old"]: continue
                    if r["busy_pre"] and not free: continue
                    if vol == "r" and float(r["c_rv30"]) < 1.25: continue
                    if any(c["minute"] < m and c["open"].get(m, 0) > 0 for c in champ): continue
                    k = (m, r["right"], free)
                    if k not in tried: tried[k] = champ_pick(sym, date, m, r["right"], float(r["price"]), free)
                    if tried[k]: got[(vol, w, free)] = (r, tried[k]); break
    ts = None
    for lm in sorted({u.split("-")[0] for u in LMODES}):
        hard, rp = int(lm[1:3]) / 10, int(lm[3]) / 10
        if any(c["minute"] >= WINS["30"] for c in champ): continue
        for r in rows:
            m = r["minute"]
            if m < WINS["30"] or m > LAST or float(r["c_t"]) < 1.5 or float(r["c_rv30"]) < 1.25: continue
            if any(c["minute"] < m and c["open"].get(m, 0) > 0 for c in champ): continue
            if ts is None: ts = tseries(sym, date)
            bet = 1 if r["right"] == "C" else -1
            past = [bet * x for x in ts[m - 180:m] if x is not None]
            steady = len(past) >= 170 and min(past) >= 1.2
            jump = ts[m - 60] is not None and float(r["c_t"]) - bet * ts[m - 60] >= hard
            if not (steady or jump): continue
            if range_pos(sym, date, m, bet) < rp: continue
            k = (m, r["right"], False)
            if k not in tried: tried[k] = champ_pick(sym, date, m, r["right"], float(r["price"]))
            if tried[k]: got[("L", lm)] = (r, tried[k]); break
    return (src, sym, date), got


def walk_late(job):
    (src, sym, date, m, right, contract), uses, r, b = job
    dbx(src)
    t = dict(sym=sym, date=date, right=right, minute=str(m), price=r["price"], c_t=r["c_t"], c_rvol=r["c_rvol"])
    v = {}
    key = lambda u: (carry_of(u), drop_of(u))
    for c, drop in sorted({key(u) for u in uses}, key=str):
        th = float(r["c_t"]) - drop if drop is not None else None
        x = walk_carry(t, m, b, CARRY[c[0]], c[1], th)
        if x is None: continue
        for u in uses:
            if key(u) == (c, drop): v[u] = x
    if not v: return None
    info = dict(contract=b[0], strike=b[2], delta=round(abs(b[3]), 3), price=b[4], vol30=b[5], how="late",
                rv30=float(r["c_rv30"]), book=bool(RB.quote(b[0], date, m)))
    return dict(src=src, kind="main", date=date, minute=m, sym=sym, right=right, late=True,
                d2=int(float(r["c_t"]) < 1.8), rvol=float(r["c_rvol"]), v=v, pick={u: info for u in v})


def curve(E, pct):
    """score_sum.account's walk, the account by day (closed + open marked): [(date, equity)] (for the page's charts)."""
    R = sorted(E, key=lambda e: e[:5])
    T = [dict(date=e[0], pnl=1e4 * e[2] * max(-1, e[3]), exit_day=e[5]["exit_day"], marks={d: e[2] * v for d, v in e[5]["marks"].items()}) for e in R]
    by = collections.defaultdict(list)
    for t in T: by[t["date"]].append(t)
    days = sorted(set(by) | {t["exit_day"] or t["date"] for t in T})
    eq, open_, prev, pts = 1e5, [], None, []
    for d in days:
        base = eq + sum(stake * t["marks"].get(prev, 0.0) for stake, t in open_)
        for t in by.get(d, []): open_.append((pct * base, t))
        keep = []
        for stake, t in open_:
            if (t["exit_day"] or t["date"]) == d: eq += stake * max(-1, t["pnl"] / 1e4)
            else: keep.append((stake, t))
        open_ = keep
        pts.append((d, round(eq + sum(stake * t["marks"].get(d, 0.0) for stake, t in open_))))
        prev = d
    return pts


def curves(R, adds):
    out = {}
    for part in ("tune", "check"):
        for v in MODES:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                for size in (0.02, 0.03):
                    out[f"{part}|{v}|{src}|{size}"] = curve(TS.entries(R, adds, src, v, part, size, a), size)
    return out


def report(R, part, out, rows_out):
    print(f"\n#### {part} weeks: the late trades (main legs at $10K, 1% basis)\n")
    print("| Version | List | Late trades (new) | Winners | Median | Sum | Giants | Non-giant sum | Held overnight | 2.10's own legs in the window: count, sum vs 2.10 | By year | Top names |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for v in MODES[1:]:
        m1 = win_of(v)
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rs = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a and v in r["v"]]
            new = [r for r in rs if r["late"]]
            own = [r for r in rs if not r["late"] and r["minute"] >= m1 and "champ" in r["v"]]
            usd = [1e4 * max(-1, r["v"][v]["r1"]) for r in new]
            g = [u for r, u in zip(new, usd) if r["v"][v]["r1"] >= 3]
            d_own = sum(1e4 * (max(-1, r["v"][v]["r1"]) - max(-1, r["v"]["champ"]["r1"])) for r in own)
            years, names = collections.defaultdict(float), collections.defaultdict(float)
            for r, u in zip(new, usd): years[r["date"][:4]] += u; names[r["sym"]] += u
            s = dict(n=len(new), win=sum(u > 0 for u in usd), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)),
                     giants=len(g), nongiant=round(sum(usd) - sum(g)), over=sum(r["v"][v]["over"] for r in new),
                     own=len(own), own_delta=round(d_own), years={y: round(x) for y, x in sorted(years.items())},
                     top=[f"{k} {x:+,.0f}" for k, x in sorted(names.items(), key=lambda kv: -kv[1])[:4]])
            out[f"{part}|{v}|{src}|late"] = s
            yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
            print(f"| {v} | {src} | {s['n']} | {s['win']} | {s['median']:+,} | {s['sum']:+,} | {s['giants']} | {s['nongiant']:+,} | {s['over']} | {s['own']}, {s['own_delta']:+,} | {yrs} | {', '.join(s['top'])} |", flush=True)
            for r, u in zip(new, usd):
                p = r["pick"][v]
                rows_out.append(dict(part=part, version=v, list=src, date=r["date"], minute=r["minute"], sym=r["sym"], right=r["right"],
                                     contract=p["contract"], price=p["price"], vol30=p["vol30"], rv30=p["rv30"], book=int(p["book"]),
                                     over=r["v"][v]["over"], usd10k=round(u)))


def main():
    mains = [("fair", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", t) for t in FR.signals("25")]
    addj = [("fair", "add", t) for t in fe.fair_signals("s_t18r15")] + [("fav", "add", t) for t in FR.signals("24")]
    L = late_rows()
    print(len(mains), "main signals,", len(addj), "add signals,", len(L), "late rows; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: C = [r for r in pool.map(walk_main, mains, chunksize=4) if r]
    champ = collections.defaultdict(list)
    for r in C:
        champ[(r["src"], r["sym"], r["date"])].append(dict(minute=r["minute"], open={m: s for m, (s, _) in r["v"]["champ"]["held"].items()}))
    for src, t in mains:   # a 2.10 signal in the window that did not trade still marks the stock's late signal
        k = (src, t["sym"], t["date"])
        if int(t["minute"]) >= WINS["15"] and not any(c["minute"] == int(t["minute"]) for c in champ[k]):
            champ[k].append(dict(minute=int(t["minute"]), open={}))
    days = collections.defaultdict(list)
    for src, r in L: days[(src, r["sym"], r["date"])].append(r)
    jobs = [(k, sorted(v, key=lambda r: r["minute"]), champ.get(k, [])) for k, v in days.items()]
    print(len(C), "2.10 main legs;", len(jobs), "stock-days with a late row", flush=True)
    with mp.Pool(8) as pool: F = pool.map(find_late, jobs, chunksize=8)
    legs = {}
    for (src, sym, date), got in F:
        for gk, (r, b) in got.items():
            k = (src, sym, date, r["minute"], r["right"], b[0])
            if gk[0] == "L": uses = [u for u in LMODES if u.startswith(gk[1] + "-")]
            else: uses = [u for u in MODES[1:] if u.startswith(f"{gk[0]}{gk[1]}-") and nofilter(u) == gk[2]]
            legs.setdefault(k, [r, b, set()])[2].update(uses)
    print(f"late legs: {len(legs)}; by vol + window:",
          dict(collections.Counter(u[:3] for v in legs.values() for u in v[2] if u.endswith("-a"))), flush=True)
    if LISTING:
        miss = sorted({(k[2], k[5], k[3]) for k in legs if not RB.quote(k[5], k[2], k[3])})
        with open(os.path.join(HERE, "open39_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(miss)
        print(f"{len(miss)} legs with no book at entry, on {len({m[0] for m in miss})} days -> open39_dbx_list.csv"); return
    lj = [(k, sorted(u), r, b) for k, (r, b, u) in legs.items()]
    with mp.Pool(8) as pool:
        Lw = pool.map(walk_late, lj, chunksize=2)
        A = pool.map(TS.one, addj, chunksize=4)
    R = C + [r for r in Lw if r] + [r for r in A if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out, rows = {}, []
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    pk = max(MODES[1:], key=score)
    out["pick"] = pk
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs champ, 2%): {pk} ({score(pk):.3f}); better on both: {score(pk) > 1}")
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run (the verdict reads the 🎯 pick only)", MODES)
    report(R, "tune", out, rows)
    report(R, "check", out, rows)
    bk = [r["pick"][next(iter(r["pick"]))]["book"] for r in R if r.get("late")]
    print(f"\nlate legs walked: {len(bk)}; a real book at entry: {sum(bk) / max(1, len(bk)):.0%}")
    json.dump(out, open(f"{B}/late_reset_summary.json", "w"), indent=1)
    json.dump(curves(R, adds), open(f"{B}/late_reset_curves.json", "w"), separators=(",", ":"))
    with open(f"{B}/late_reset_legs.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
