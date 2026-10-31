"""nightly-bet v2: the measurements, done properly, on ~310 stocks (the user 2026-10-31: "how did you messure it? it should
be much more sofisticated - for each messurment we need to figure out how to messure. also we still have very few
enters- I want atlist 300 ayer", then "go ahead" on the plan: a wider universe, each part measured in its own way, the
stocks alone first (no options), judged by what an option needs: a big overnight move, not its sign).

Every stock-day from 2024-02-01 at 15:57 New York (minute 387), each side (C = the call side, P = the put side; every
measure is signed so that "good for this side" is high). The stock's factors: SPY and its sector ETF (of XLK XLF XLE
XLV XLI XLY XLP XLU XLB XLRE XLC SMH, the one whose daily residual moves track the stock's best over the prior 120
sessions, chosen again each month). Betas from the prior 60 sessions' daily returns.

RS (against SPY)
  rs_day   today's move to 15:57 from the day before's close, minus beta x SPY and the sector's own residual, in the
           stock's daily residual volatility (z)
  gap_z    the same for the open's gap alone
  rs_3d    the residual of the 3 days before, z
  t        the bot's t: mean / std x sqrt(n) of the minute excess moves (stock - beta5 x SPY) from 09:31 to 15:57,
           beta5 from 5-minute returns of the prior 20 sessions
  consist  the share of the 13 half-hours (09:30-15:57) the stock beat beta5 x SPY
  rs_down  the excess move summed over the 5-minute blocks in which SPY fell, in S30 (holding up when SPY drops)
VOLUME (participation)
  rvol     day volume to 15:57 / the usual volume to 15:57 (per-minute median of the prior 20 sessions, earnings
           reaction days left out), log
  rvol_late  the last 2 hours' volume / its usual, log
  updown   (volume on rising minutes - volume on falling minutes) / all volume
  dollar   log dollar volume to 15:57 (liquidity, for the option)
BURST (news)
  a burst minute: volume >= 5x that minute's usual and >= usual + 8 robust deviations (1.4826 x MAD of the 20 sessions);
  burst minutes within 2 minutes of each other are one event. Per event: size = its extra volume / the usual day's
  volume; impact = its excess move (start - 1 to end) in S30; hold = the excess move from its start - 1 to 15:57 /
  its impact (1 = all kept, 0 = faded, > 1 = kept going).
  burst    max over events of impact (its side) x hold (clipped 0..1.5) x sqrt(size x 100)
  burst_n, burst_size (largest), burst_hold (of the best event), burst_age (minutes from its end to 15:57)
PULLBACK (the last hour's shape)
  lh_run   the last hour's excess move (14:57 -> 15:57), in S30 (a run into the close is high)
  depth    from the last hour's high (calls) / low (puts) back to 15:57, in S30
  lh_range the last hour's high - low / its usual (20 sessions), log
  pos      the day's range position on its side
  gap_hold the move to 15:57 / the gap at the open, when the gap was at least half a daily residual sd its way
  vwap_ext the distance from the day's VWAP to 15:57, in S30
TARGET (what an option needs)
  on       the move from 15:57 to 09:45 next day (raw, its side); z_on = on / the sd of the prior 60 such moves
  opt      a modelled 0.20-delta option expiring at the next close: Black-Scholes at the stock's 20-day realised vol
           x 1.43 (the champion's implied / realised, checked on 2024-26), bought at 15:57 and marked at 09:45 at the
           same vol, return = mark / cost - 1 (no spread, no crush: a ranking yardstick, not a P&L)
Also earn (1 = tonight or tomorrow is an earnings reaction day: left out of the study) and half (split.half).

  node --env-file=.env <dir>/run.mjs nightly_feat.py     (from the app repo root) -> data/local/x/bt/nightly_feat.csv.gz
"""
import bisect, csv, datetime as dt, glob, gzip, json, math, multiprocessing as mp, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import day
from split import half

A0 = "2024-02-01"
M = 387
OUT = "data/local/x/bt/nightly_feat.csv.gz"
SECT = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC", "SMH"]
NOT = set("SPY VOO DIA AGG HYG IEF SHY TLT UTEN UTHY UTWO UTWY UFIV UUP UVXY VIXY SQQQ SOXS TZA SPXL SOXL TNA TQQQ NVDL TSLL CONL LABU".split()) | set(SECT)
CAL = [r[0] for r in __import__("store").db.execute("SELECT date FROM bars WHERE symbol='SPY' ORDER BY date")]
IDX = {d: i for i, d in enumerate(CAL)}


def universe():
    rows = __import__("store").db.execute("SELECT symbol, count(*) FROM bars WHERE date >= ? GROUP BY symbol", (A0,)).fetchall()
    return sorted(s for s, n in rows if n >= 600 and not any(ch.isdigit() for ch in s) and s not in NOT)


def earnings_days():
    """{sym: set of reaction-day calendar indices}, from the cached Nasdaq calendar files (earnings.py)."""
    out = {}
    for f in sorted(glob.glob("data/local/x/bt/earn/*.json")):
        d = os.path.basename(f)[:10]
        i = bisect.bisect_left(CAL, d)
        if i >= len(CAL): continue
        same = CAL[i] == d
        for s, t in json.load(open(f)):
            r = out.setdefault(s, set())
            if t == "time-pre-market" and same: r.add(i)
            elif t == "time-after-hours" and same: r.add(i + 1)
            else: r.update({i, i + 1} if same else {i})   # time not supplied: both days
    return out


_mem = {}
def arrays(sym, d):
    """(open, high, low, close, volume) x 390, closes carried forward; None if under 300 bars."""
    k = (sym, d)
    if k in _mem: return _mem[k]
    b = day(sym, d)
    if len(b) < 300: _mem[k] = None; return None
    a = np.full((5, 390), np.nan)
    for x in b:
        if 0 <= x[0] < 390: a[:, x[0]] = (x[1], x[2], x[3], x[4], x[5])
    v = np.nan_to_num(a[4])
    c = a[3]
    first = np.flatnonzero(~np.isnan(c))[0]
    c[:first] = a[1][first] if not np.isnan(a[1][first]) else c[first]
    for m in range(1, 390):
        if np.isnan(c[m]): c[m] = c[m - 1]
    o = np.where(np.isnan(a[0]), c, a[0]); h = np.where(np.isnan(a[1]), c, a[1]); l = np.where(np.isnan(a[2]), c, a[2])
    r = (o, h, l, c, v)
    if sym in SECT or sym == "SPY": _mem[k] = r
    return r


def ols(y, X):
    X1 = np.column_stack([np.ones(len(y)), X])
    b, *_ = np.linalg.lstsq(X1, y, rcond=None)
    return b, y - X1 @ b


def bs(S, K, T, v, call=True):
    if T <= 0 or v <= 0: return max(0.0, (S - K) if call else (K - S))
    d1 = (math.log(S / K) + 0.5 * v * v * T) / (v * math.sqrt(T)); d2 = d1 - v * math.sqrt(T)
    N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
    return S * N(d1) - K * N(d2) if call else K * N(-d2) - S * N(-d1)


def strike20(S, T, v, call=True):
    """The strike at delta 0.20 (call) / -0.20 (put)."""
    z = 0.8416   # N^-1(0.80)
    return S * math.exp((z if call else -z) * v * math.sqrt(T) + 0.5 * v * v * T)


def work(sym):
    ER = EARN.get(sym, set())
    i0 = max(130, bisect.bisect_left(CAL, A0) - 0)
    days = {}   # calendar index -> arrays
    for i in range(i0 - 130, len(CAL)):
        a = arrays(sym, CAL[i])
        if a: days[i] = a
    out = []
    dret = lambda s, i: (arrays(s, CAL[i])[3][389] / arrays(s, CAL[i - 1])[3][389] - 1) if arrays(s, CAL[i]) and arrays(s, CAL[i - 1]) else None
    sret = {}
    def stock_ret(i):
        if i not in sret: sret[i] = days[i][3][389] / days[i - 1][3][389] - 1 if i in days and i - 1 in days else None
        return sret[i]
    sect, sect_month = None, None
    ons = []   # (i, raw overnight return) for the sd of past overnight moves
    for i in range(i0 - 70, len(CAL) - 1):
        if i not in days or i + 1 not in days or CAL[i] < A0:
            if i in days and i + 1 in days:
                ons.append((i, days[i + 1][3][15] / days[i][3][M] - 1))
            continue
        o, h, l, c, v = days[i]
        on_raw = days[i + 1][3][15] / c[M] - 1
        past = [k for k in range(i - 60, i) if k in days and k - 1 in days]
        if len(past) < 45 or i - 1 not in days: ons.append((i, on_raw)); continue
        # the sector ETF, chosen monthly from the prior 120 sessions
        if CAL[i][:7] != sect_month:
            sect_month = CAL[i][:7]
            ks = [k for k in range(i - 120, i) if k in days and k - 1 in days]
            ys = np.array([stock_ret(k) for k in ks]); sp = np.array([dret("SPY", k) or 0 for k in ks])
            _, ry = ols(ys, sp)
            best = (-2, None)
            for e in SECT:
                ee = np.array([dret(e, k) or 0 for k in ks])
                _, re_ = ols(ee, sp)
                cc = np.corrcoef(ry, re_)[0, 1] if np.std(re_) > 0 else -2
                if cc > best[0]: best = (cc, e)
            sect = best[1]
        ys = np.array([stock_ret(k) for k in past])
        sp = np.array([dret("SPY", k) or 0 for k in past]); ee = np.array([dret(sect, k) or 0 for k in past])
        be, _ = ols(ee, sp); eres = ee - be[0] - be[1] * sp
        b, res = ols(ys, np.column_stack([sp, eres]))
        sid = float(np.std(res)) or 1e-4
        S0, E0 = arrays("SPY", CAL[i]), arrays(sect, CAL[i]); S1, E1 = arrays("SPY", CAL[i - 1]), arrays(sect, CAL[i - 1])
        if not (S0 and E0 and S1 and E1): ons.append((i, on_raw)); continue
        pc = days[i - 1][3][389]
        def idio(r_s, r_spy, r_e): return r_s - b[1] * r_spy - b[2] * (r_e - be[1] * r_spy)
        rs_day = idio(c[M] / pc - 1, S0[3][M] / S1[3][389] - 1, E0[3][M] / E1[3][389] - 1) / sid
        gap_z = idio(o[0] / pc - 1, S0[0][0] / S1[3][389] - 1, E0[0][0] / E1[3][389] - 1) / sid
        r3 = []
        for k in (i - 3, i - 2, i - 1):
            if k in days and k - 1 in days and arrays("SPY", CAL[k]) and arrays(sect, CAL[k]):
                r3.append(idio(stock_ret(k), dret("SPY", k) or 0, dret(sect, k) or 0))
        rs_3d = sum(r3) / (sid * math.sqrt(3)) if len(r3) == 3 else 0.0
        # minute-level: beta5 and S30 from the prior 20 sessions
        p20 = [k for k in range(i - 20, i) if k in days and arrays("SPY", CAL[k])][-20:]
        if len(p20) < 12: ons.append((i, on_raw)); continue
        x5, y5, r1 = [], [], []
        for k in p20:
            cc, ss = days[k][3], arrays("SPY", CAL[k])[3]
            y5.append(cc[5::5] / cc[:-5:5][:len(cc[5::5])] - 1); x5.append(ss[5::5] / ss[:-5:5][:len(ss[5::5])] - 1)
            r1.append(np.diff(cc) / cc[:-1])
        x5 = np.concatenate(x5); y5 = np.concatenate(y5)
        beta5 = float(np.cov(x5, y5)[0, 1] / np.var(x5)) if np.var(x5) > 0 else 1.0
        S30 = float(np.std(np.concatenate(r1))) * math.sqrt(30) or 1e-4
        sc = S0[3]
        er = np.diff(c[:M + 1]) / c[:M] - beta5 * np.diff(sc[:M + 1]) / sc[:M]
        t = float(er.mean() / er.std() * math.sqrt(len(er))) if er.std() > 0 else 0.0
        hh = [(c[min(M, k + 30)] / c[k] - 1) - beta5 * (sc[min(M, k + 30)] / sc[k] - 1) for k in range(0, M, 30)]
        consist = sum(x > 0 for x in hh) / len(hh)
        blocks = [(k, k + 5) for k in range(0, M - 4, 5)]
        dn = sum((c[q] / c[p] - 1) - beta5 * (sc[q] / sc[p] - 1) for p, q in blocks if sc[q] < sc[p]) / S30
        # volume: usual per minute (earnings reaction days out), robust spread
        pv = np.array([days[k][4] for k in p20 if k not in ER]) if sum(k not in ER for k in p20) >= 10 else np.array([days[k][4] for k in p20])
        med = np.median(pv, axis=0); mad = np.median(np.abs(pv - med), axis=0) * 1.4826
        usual_day = float(med.sum()) or 1.0
        rvol = math.log(max(v[:M + 1].sum(), 1) / max(med[:M + 1].sum(), 1))
        rvol_late = math.log(max(v[267:M + 1].sum(), 1) / max(med[267:M + 1].sum(), 1))
        dc = np.sign(np.diff(c[:M + 1]))
        updown = float((v[1:M + 1] * dc).sum() / max(v[1:M + 1].sum(), 1))
        dollar = math.log(max(v[:M + 1].sum() * c[M], 1))
        # bursts
        thr = np.maximum(5 * med, med + 8 * np.maximum(mad, 1))
        flag = [m for m in range(1, M + 1) if v[m] >= thr[m] and v[m] > 0]
        ev = []
        for m in flag:
            if ev and m - ev[-1][1] <= 2: ev[-1][1] = m
            else: ev.append([m, m])
        bursts = []
        for a_, z_ in ev:
            size = float((v[a_:z_ + 1] - med[a_:z_ + 1]).clip(0).sum() / usual_day)
            imp = ((c[z_] / c[a_ - 1] - 1) - beta5 * (sc[z_] / sc[a_ - 1] - 1)) / S30
            kept = ((c[M] / c[a_ - 1] - 1) - beta5 * (sc[M] / sc[a_ - 1] - 1)) / S30
            hold = kept / imp if abs(imp) >= 0.3 else 0.0
            bursts.append((size, imp, hold, M - z_))
        # last hour, range, VWAP, gap
        hiL, loL = float(h[M - 60:M + 1].max()), float(l[M - 60:M + 1].min())
        lhr = []
        for k in p20:
            hk, lk, ck = days[k][1], days[k][2], days[k][3]
            lhr.append((hk[M - 60:M + 1].max() - lk[M - 60:M + 1].min()) / ck[M])
        lh_range = math.log(max((hiL - loL) / c[M], 1e-6) / max(float(np.median(lhr)), 1e-6))
        lh_ex = ((c[M] / c[M - 60] - 1) - beta5 * (sc[M] / sc[M - 60] - 1)) / S30
        dhi, dlo = float(h[:M + 1].max()), float(l[:M + 1].min())
        pos = (c[M] - dlo) / (dhi - dlo) if dhi > dlo else 0.5
        vw = float((((h + l + c) / 3)[:M + 1] * v[:M + 1]).sum() / max(v[:M + 1].sum(), 1))
        vwap_ext = (c[M] / vw - 1) / S30 if vw > 0 else 0.0
        gap = o[0] / pc - 1
        # target
        prior_on = [x for k, x in ons[-60:]]
        sd_on = float(np.std(prior_on)) if len(prior_on) >= 40 else None
        ons.append((i, on_raw))
        r20 = [stock_ret(k) for k in range(i - 20, i) if stock_ret(k) is not None]
        vol_ann = float(np.std(r20)) * math.sqrt(252) * 1.43 if len(r20) >= 15 else None
        T0, T1 = (393 / 390) / 252, (375 / 390) / 252
        S_exit = days[i + 1][3][15]
        earn = int(i in ER or (i + 1) in ER)
        for side, bet in (("C", 1), ("P", -1)):
            bb = [(sz, bet * im, ho, ag) for sz, im, ho, ag in bursts]
            score = [im * min(max(ho, 0), 1.5) * math.sqrt(sz * 100) for sz, im, ho, ag in bb if im > 0]
            best = max(range(len(bb)), key=lambda j: (bb[j][1] * min(max(bb[j][2], 0), 1.5) * math.sqrt(bb[j][0] * 100)) if bb[j][1] > 0 else -1) if bb else None
            gh = (c[M] / pc - 1) / gap if bet * gap >= 0.5 * sid and gap != 0 else ""
            opt = ""
            if vol_ann:
                K = strike20(c[M], T0, vol_ann, side == "C")
                p0 = bs(c[M], K, T0, vol_ann, side == "C")
                if p0 > 0: opt = round(bs(S_exit, K, T1, vol_ann, side == "C") / p0 - 1, 4)
            out.append([sym, CAL[i], side, half(CAL[i]), earn, sect,
                        round(bet * rs_day, 3), round(bet * gap_z, 3), round(bet * rs_3d, 3), round(bet * t, 3),
                        round(consist if bet > 0 else 1 - consist, 3), round(bet * dn, 3),
                        round(rvol, 3), round(rvol_late, 3), round(bet * updown, 3), round(dollar, 2),
                        round(max(score) if score else 0.0, 3), len(bursts),
                        round(max((x[0] for x in bursts), default=0.0), 4),
                        round(bb[best][2], 3) if best is not None and bb[best][1] > 0 else "",
                        bb[best][3] if best is not None and bb[best][1] > 0 else "",
                        round(bet * lh_ex, 3), round(((hiL - c[M]) if bet > 0 else (c[M] - loL)) / c[M] / S30, 3), round(lh_range, 3),
                        round(pos if bet > 0 else 1 - pos, 3), round(gh, 3) if gh != "" else "", round(bet * vwap_ext, 3),
                        round(bet * on_raw, 5), round(bet * on_raw / sd_on, 3) if sd_on else "", opt])
    return out


HEAD = ["sym", "date", "side", "half", "earn", "sect", "rs_day", "gap_z", "rs_3d", "t", "consist", "rs_down",
        "rvol", "rvol_late", "updown", "dollar", "burst", "burst_n", "burst_size", "burst_hold", "burst_age",
        "lh_run", "depth", "lh_range", "pos", "gap_hold", "vwap_ext", "on", "z_on", "opt"]
EARN = earnings_days()

if __name__ == "__main__":
    U = universe()
    print(len(U), "stocks", flush=True)
    n = 0
    with gzip.open(OUT, "wt") as f, mp.Pool(8) as pool:
        w = csv.writer(f); w.writerow(HEAD)
        for rows in pool.imap_unordered(work, U):
            w.writerows(rows); n += 1
            if n % 25 == 0: print(n, "done", flush=True)
    print("->", OUT)
