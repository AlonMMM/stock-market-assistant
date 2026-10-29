"""Enter the second the side is crossed, not on the 1-minute close (the user, 2026-10-26: "why do we wait to the candle
to close?"). The Volume bot's alerts over the last 12 months on the watchlist (167 stocks); for each, the stock's
1-second bars (Databento EQUS.MINI ohlcv-1s) over the 10 minutes after the alert, and the chosen contract's 1-second
bid/ask (OPRA cbbo-1s) around the entry. Entries:
  close     now: the first 1-minute close 0.25 x S30 from the alert price; the book at the end of that minute
  cross     the first second the stock trades 0.25 x S30 away
  holdN     the first time it stays beyond the line N seconds in a row (5, 10)
A second entry buys LAG seconds after the trigger (the bot's reaction), at the mid + half the way to the ask of that
second's book; if the bid 10 seconds on is already above that, the ask then, at most +10% (the chase). Contract: the
version's own pick on the last whole minute before the entry. The exit as always (the 0.75 x S30 give-back on minute
closes, out by 15:30), sold at the real bid (cbbo-1m). Live limits, 1% a trade, re-entry up to 2 a stock a day.
  node --env-file=.env <dir>/run.mjs leg_seconds.py list|stock|pick|option|run      (from the app repo root)
"""
import base64, csv, gzip, http.client, io, json, multiprocessing as mp, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import leg_realspread as RS
import sim
from store import day, P
from levels import ctx
from rvol_alert import alerts_for
from zero5 import FIRST, LAST
from cheap_up import candidates
import leg_twice as TW
import leg_fallback as LF
import leg_daycap as D
import week_count as WC

C, CAL = sim.C, TW.CAL
FROM = os.environ.get("SEC_FROM", "2025-10-23")   # SEC_FROM=2024-02-01 SEC_TAG=3y: the 3 years (cmbp-1 before cbbo-1s exists)
TAG = os.environ.get("SEC_TAG", "")
if os.environ.get("SEC_WAIT"): TW.WAIT = int(os.environ["SEC_WAIT"])   # the side's give-up, minutes (live 10)
WTAG = "" if TW.WAIT == 10 else f"_w{TW.WAIT}"
if os.environ.get("SEC_K"): TW.K = float(os.environ["SEC_K"])   # the side line, x S30 (live 0.25)
KTAG = "" if TW.K == 0.25 else f"_k{TW.K}"
SEC1 = "2025-02-20"
OUT = os.path.join(HERE, "sec_cache")
NY = ZoneInfo("America/New_York")
LAG = 2
ENTRIES = ("close", "cross", "hold5", "hold10", "hold30")
VERSIONS = tuple(os.environ.get("SEC_VERSIONS", "plain20,step8c25").split(","))   # SEC_VERSIONS=plain20,plain10: the contracts to pick and run


def utc(date, sec):
    h, r = divmod(34200 + sec, 3600); m, s = divmod(r, 60)
    return datetime.fromisoformat(f"{date}T{h:02d}:{m:02d}:{s:02d}").replace(tzinfo=NY).astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S")


def get(dataset, schema, symbol, date, a, z):
    auth = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
    data = urllib.parse.urlencode(dict(dataset=dataset, schema=schema, stype_in="raw_symbol", encoding="csv", pretty_px="true",
                                       pretty_ts="true", symbols=symbol, start=utc(date, a), end=utc(date, z))).encode()
    req = urllib.request.Request("https://hist.databento.com/v0/timeseries.get_range", data=data, headers={"Authorization": auth})
    for tries in range(6):
        try: return urllib.request.urlopen(req, timeout=300).read().decode()
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead) as e:
            if tries == 5: raise
            time.sleep(10 * (tries + 1))


def sec_of(ts):
    t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(NY)
    return t.hour * 3600 + t.minute * 60 + t.second - 34200


def events_of(job):
    date, sym, kind = job
    if date < FROM: return []
    al = alerts_for(sym, date, CAL)
    if not al: return []
    x = ctx(sym, date)
    if not x or not x.get("sd"): return []
    sb = {b[0]: b for b in day(sym, date)}
    nxt = CAL[CAL.index(date) + 1] if kind == "1" else date
    if kind == "w": nxt = WC.week_expiry(sym, date)   # the nearest expiry later this week (2-4 DTE)
    if kind == "l": nxt = WC.late_expiry(sym, date)   # a late alert: the nearest expiry 2-7 days out
    first, last = int(os.environ.get("SEC_FIRST", FIRST)), int(os.environ.get("SEC_LAST", LAST))   # SEC_FIRST=210 SEC_LAST=388: the late window
    out = [dict(date=date, sym=sym, kind=kind, nxt=nxt, m=q, u=x["sd"], stock0=sb[q][4]) for q in range(first, last + 1)
           if al[q] and not al[q - 1] and q in sb]
    if os.environ.get("SEC_AM_PRE"):   # keep only a burst this strong either way (before any download)
        k = float(os.environ["SEC_AM_PRE"])
        out = [e for e in out if e["m"] - 3 in sb and abs(sb[e["m"]][4] / sb[e["m"] - 3][4] - 1) / e["u"] >= k]
    return out


def stock_path(e):
    if "sec0" in e: return os.path.join(OUT, "stock", f"{e['date']}_{e['sym']}_s{e['sec0']}{WTAG}.csv.gz")
    return os.path.join(OUT, "stock", f"{e['date']}_{e['sym']}_{e['m']}{WTAG}.csv.gz")


def fast_events():
    """The fast alert's events (fast_alerts.py): the alert's 10-second slot end, the stock's price then."""
    import leg_1dte as L1
    out = []
    for a in json.load(open(os.path.join(OUT, os.environ.get("SEC_ALERT_FILE", "fast_alerts.json")))):   # or an early_prep.py file
        if a["date"] < FROM or a["date"] not in CAL: continue
        k = L1.kind_of(a["sym"], a["date"])
        x = ctx(a["sym"], a["date"])
        nxt = None
        if not k and os.environ.get("SEC_FAST_WEEK"):   # no 0/1 DTE: the nearest expiry later that week (kind "w")
            nxt = WC.week_expiry(a["sym"], a["date"]); k = "w" if nxt else None
        if not k or not x or not x.get("sd"): continue
        if not nxt: nxt = CAL[CAL.index(a["date"]) + 1] if k == "1" else a["date"]
        out.append(dict(date=a["date"], sym=a["sym"], kind=k, nxt=nxt, m=a["sec"] // 60, sec0=a["sec"], u=x["sd"], stock0=a["price"]))
    return out


def fetch_stock(e):
    p = stock_path(e)
    if os.path.exists(p): return
    a = e["sec0"] if "sec0" in e else (e["m"] + 1) * 60
    z = a + TW.WAIT * 60
    text = get("EQUS.MINI", "ohlcv-1s", e["sym"], e["date"], a, z)
    rows = [(sec_of(r["ts_event"]), r["close"]) for r in csv.DictReader(io.StringIO(text))]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with gzip.open(p + ".tmp", "wt") as f: csv.writer(f).writerows(rows)
    os.replace(p + ".tmp", p)


def triggers(e):
    """{entry: (trigger second, side, stock price) or None}."""
    sb = {b[0]: b for b in day(e["sym"], e["date"])}
    th = TW.K * e["u"]; out = {k: None for k in ENTRIES}
    for t in range(e["m"] + 1, e["m"] + TW.WAIT + 1):
        if t in sb and abs(sb[t][4] / e["stock0"] - 1) >= th:
            out["close"] = ((t + 1) * 60, "C" if sb[t][4] > e["stock0"] else "P", sb[t][4]); break
    p = stock_path(e)
    if not os.path.exists(p): return out
    secs = [(int(s), float(c)) for s, c in csv.reader(gzip.open(p, "rt"))]
    run, side0 = 0, None
    for s, c in secs:
        side = None
        if c >= e["stock0"] * (1 + th): side = "C"
        if c <= e["stock0"] * (1 - th): side = "P"
        if side and out["cross"] is None: out["cross"] = (s, side, c)
        if side and side == side0: run += 1
        elif side: run, side0 = 1, side
        else: run, side0 = 0, None
        for n in (5, 10, 30):
            if side and run >= n and out[f"hold{n}"] is None: out[f"hold{n}"] = (s, side, c)
    return out


def pick_for(job):
    """The contract each version buys for each entry: picked on the last whole minute before the entry."""
    e, trig = job
    C.update(dte_min=0, dte_max=0, delta=0.35) if e["kind"] == "0" else C.update(dte_min=1, dte_max=5, delta=0.35)
    if e["kind"] in ("w", "l"): C.update(dte_min=0 if e["kind"] == "w" else 2, dte_max=(datetime.fromisoformat(e["nxt"]) - datetime.fromisoformat(e["date"])).days)
    out = {}
    for entry, tg in trig.items():
        if not tg: continue
        sec, side, spot = tg
        cm = sec // 60 - 1
        got, why = sim.pick(e["sym"], e["date"], cm, side, spot)
        if why in ("no_expiry", "no_strikes"): continue
        cands = [c for c in candidates(e["sym"], e["date"], cm, side, spot) if c[1] == e["nxt"]]
        for v in VERSIONS:
            c = RS.pick(cands, v, e["date"], cm) if cands else None
            if c: out[(entry, v)] = (c[0], abs(c[3]))
    return out


def opt_path(e, contract, sec): return os.path.join(OUT, "opt", f"{e['date']}_{contract}_{sec}.csv.gz")


def fetch_opt(args):
    e, contract, sec = args
    p = opt_path(e, contract, sec)
    if os.path.exists(p): return
    m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", contract)
    if e["date"] >= SEC1:   # a cbbo-1s row stamped second s + 1 is the book as second s ended
        text = get("OPRA.PILLAR", "cbbo-1s", m.group(1).ljust(6) + m.group(2), e["date"], sec - 2, sec + LAG + 12)
        rows = [(sec_of(r["ts_recv"]) - 1, r["bid_px_00"], r["ask_px_00"]) for r in csv.DictReader(io.StringIO(text)) if r["bid_px_00"] and r["ask_px_00"]]
    else:                   # before it: every change of the best bid/ask; the last one in a second is that second's book
        text = get("OPRA.PILLAR", "cmbp-1", m.group(1).ljust(6) + m.group(2), e["date"], sec - 30, sec + LAG + 12)
        rows = [(sec_of(r["ts_recv"]), r["bid_px_00"], r["ask_px_00"]) for r in csv.DictReader(io.StringIO(text)) if r["bid_px_00"] and r["ask_px_00"]]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with gzip.open(p + ".tmp", "wt") as f: csv.writer(f).writerows(rows)
    os.replace(p + ".tmp", p)


def opt2_path(e, contract, sec): return os.path.join(OUT, "opt2", f"{e['date']}_{contract}_{sec}.csv.gz")


def fetch_opt2(args):
    """The book with sizes from 2 s before the trigger to 80 s after it: second, bid, ask, bid size, ask size."""
    e, contract, sec = args
    p = opt2_path(e, contract, sec)
    if os.path.exists(p): return
    m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", contract)
    schema, back, shift = ("cbbo-1s", 2, 1) if e["date"] >= SEC1 else ("cmbp-1", 30, 0)
    text = get("OPRA.PILLAR", schema, m.group(1).ljust(6) + m.group(2), e["date"], sec - back, sec + LAG + 80)
    rows = [(sec_of(r["ts_recv"]) - shift, r["bid_px_00"], r["ask_px_00"], r["bid_sz_00"], r["ask_sz_00"])
            for r in csv.DictReader(io.StringIO(text)) if r["bid_px_00"] and r["ask_px_00"]]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with gzip.open(p + ".tmp", "wt") as f: csv.writer(f).writerows(rows)
    os.replace(p + ".tmp", p)


def usual_buy(rows, t):
    """The bot's usual price at second t: mid + half to the ask, and the ask (capped at +10%) if the bid runs past it."""
    q = book_at(rows, t)
    if not q: return None
    buy = (q[0] + q[1]) / 2 + (q[1] - q[0]) / 4
    later = book_at(rows, t + 10)
    if later and later[0] > buy: buy = min(later[1], buy * 1.1)
    return buy


def limit_buy(rows, t0, mode):
    """A fair-price limit (STR_BUY): microprice + 3 ticks, never above the usual price. micro60: wait 60 s, then the usual
    price. step5: one tick higher every 5 s up to the usual start, 60 s at most, then the usual price. A limit fills when
    the ask comes down to it (quotes only: no trades, so fills by a seller hitting our bid are not counted).
    -> (price, 'limit' or 'late', seconds waited) or None"""
    k = [r for r in rows if r[0] <= t0]
    if not k: return None
    bid, ask, bsz, asz = (float(x) for x in k[-1][1:5])
    start = (bid + ask) / 2 + (ask - bid) / 4
    micro = (bid * asz + ask * bsz) / (bsz + asz) if bsz + asz > 0 else (bid + ask) / 2
    tick = 0.01 if ask < 3 else 0.05
    lim = min(micro + 3 * tick, start)
    if mode == "pct": lim = min(micro * (1 + float(os.environ.get("STR_BUY_PCT", "0")) / 100), start)   # microprice + x%
    if mode == "mid": lim = (bid + ask) / 2   # the mid for the wait, then the usual price
    if mode == "micro_mid": lim = min(micro, (bid + ask) / 2)   # the microprice for 1 s, the mid for the next, then the usual
    wait = int(os.environ.get("STR_BUY_WAIT", "60"))   # seconds before paying the usual price
    for s in range(t0 + 1, t0 + wait + 1):
        if mode == "step5" and (s - t0) % 5 == 0: lim = min(lim + tick, start)
        if mode == "micro_mid" and s - t0 == 2: lim = (bid + ask) / 2
        b = book_at(rows, s)
        if b and b[1] <= lim + 1e-9: return min(lim, b[1]), "limit", s - t0
    late = usual_buy(rows, t0 + wait)
    return (late, "late", wait) if late else None


def book_at(rows, s):
    k = [r for r in rows if r[0] <= s]
    return (float(k[-1][1]), float(k[-1][2])) if k else None


EXIT10 = {}
if os.environ.get("STR_EXIT") == "sec10":   # EXIT10_MODE picks the file (exit10.py)
    _m = os.environ.get("EXIT10_MODE", "live")
    EXIT10 = json.load(open(os.path.join(OUT, f"exit10_{TAG}{'' if _m == 'live' else '_' + _m}.json")))


BS = os.environ.get("STR_FILL") == "bs"   # the option from the stock's price at the second, Black-Scholes at the bar's implied volatility
BARS = os.environ.get("STR_FILL") == "bars" or BS


def bs_price(e, contract, side, minute_iv, minute_t, spot):
    """The option's model price with the stock at `spot` at session minute `minute_t`: the implied volatility of the
    option's last 1-minute bar at or before `minute_iv` (at most 10 minutes old, with the stock's close of that minute),
    Black-Scholes. None without a usable bar."""
    import re as _re
    from store import bs as _bs, iv_delta as _ivd, years_to_expiry as _yte
    m = _re.match(r"^[A-Z.]+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$", contract)
    if not m: return None
    exp = f"20{m.group(1)}-{m.group(2)}-{m.group(3)}"; k = int(m.group(5)) / 1000; call = m.group(4) == "C"
    ob = [b for b in day(contract, e["date"]) if minute_iv - 10 <= b[0] <= minute_iv]
    sb = {b[0]: b[4] for b in day(e["sym"], e["date"])}
    for b in reversed(ob):
        if b[0] in sb:
            x = _ivd(b[4], sb[b[0]], k, _yte(e["date"], b[0], exp), 0.04, call)
            if x: return _bs(spot, k, _yte(e["date"], minute_t, exp), x[0], 0.04, call)[0]
    return None
if BARS and os.environ.get("STR_SH"): LF.SH = float(os.environ["STR_SH"])   # e.g. 0.03: buy at the middle + 3%, sell at - 3%


def trade(job):
    """One version's trade for one entry of one alert, or None."""
    e, entry, v, contract, delta, tg = job
    sec, side, spot = tg
    if entry == "close":
        q = RS.quote(contract, e["date"], sec // 60 - 1)
        if not q: return None
        buy = RS.fill(contract, e["date"], sec // 60 - 1, q); ct = sec // 60 - 1
    elif BARS:   # STR_FILL=bars: the option from its 1-minute bars, the bar's middle +- STR_SH (no quotes needed)
        ct = sec // 60; buy = None
    else:
        p = opt_path(e, contract, sec)
        if not os.path.exists(p): return None
        rows = [r for r in csv.reader(gzip.open(p, "rt"))]
        rows = [(int(a), b, c) for a, b, c in rows if float(b) > 0 and float(c) > 0]
        q = book_at(rows, sec + LAG)
        if not q: return None
        mid = (q[0] + q[1]) / 2; buy = mid + (q[1] - mid) / 2
        if os.environ.get("STR_MAX_SPREAD") and (q[1] - q[0]) > float(os.environ["STR_MAX_SPREAD"]) * mid:
            return None   # STR_MAX_SPREAD=0.1: no buy when the spread at the buy is over 10% of the mid (the user, 2026-10-28)
        later = book_at(rows, sec + LAG + 10)
        if later and later[0] > buy: buy = min(later[1], buy * 1.1)
        ct = sec // 60
        if entry == "cross" and os.environ.get("STR_BUY"):   # STR_BUY=micro60|step5: the fair-price limit buy
            p2 = opt2_path(e, contract, sec)
            if not os.path.exists(p2): return None
            rows2 = [(int(r[0]), *r[1:]) for r in csv.reader(gzip.open(p2, "rt")) if float(r[1]) > 0 and float(r[2]) > 0]
            lb = limit_buy(rows2, sec + LAG, os.environ["STR_BUY"])
            if not lb: return None
            buy, fill, waited = lb
    if BARS:
        w0 = LF.walk(e["sym"], e["date"], ct, side, contract, spot, e["u"])
        if not w0: return None
        buy = w0[0]; q = (buy / (1 + LF.SH), buy / (1 + LF.SH))
        if BS:   # the buy at the cross second + LAG: the stock's 1-second price, the bar before the buy for the volatility
            s_buy = spot
            sp = stock_path(e)
            if os.path.exists(sp):
                k2 = [float(c) for a, c in csv.reader(gzip.open(sp, "rt")) if int(a) <= sec + LAG]
                if k2: s_buy = k2[-1]
            px = bs_price(e, contract, side, ct - 1, ct, s_buy)
            if not px: return None
            buy = px * (1 + LF.SH); q = (px, px)
    mid_in = (q[0] + q[1]) / 2
    stock_in = spot   # the minute close (close entry) or the trigger second's price
    if entry != "close":
        sp = stock_path(e)
        if os.path.exists(sp):
            secs = [(int(a), float(b)) for a, b in csv.reader(gzip.open(sp, "rt"))]
            k = [c for a, c in secs if a <= sec + LAG]
            if k: stock_in = k[-1]
    w = LF.walk(e["sym"], e["date"], ct, side, contract, spot, e["u"])
    if not w: return None
    stop = float(os.environ.get("STR_STOP", "0"))   # STR_STOP=0.4: sell once the option is 40% under the buy (STR_STOP_ON=bid|mid)
    if stop:
        for k in range(ct, w[3]):
            q2 = RS.quote(contract, e["date"], k)
            if not q2: continue
            px = q2[0] if os.environ.get("STR_STOP_ON", "bid") == "bid" else (q2[0] + q2[1]) / 2
            if px <= buy * (1 - stop): w = (w[0], w[1], w[2], k); break
    qs = (w[1], w[1]) if BARS else RS.quote(contract, e["date"], w[3])
    if BS:   # the sale at the exit minute's close: the stock's close, the option's bar up to it for the volatility
        sbx0 = {b[0]: b[4] for b in day(e["sym"], e["date"])}
        s_out = next((sbx0[k] for k in range(w[3], w[3] - 5, -1) if k in sbx0), None)
        px = bs_price(e, contract, side, w[3], w[3] + 1, s_out) if s_out else None
        if px is None: return None
        qs = (max(px * (1 - LF.SH), 0.01), max(px * (1 - LF.SH), 0.01))
    if not qs: return None
    if os.environ.get("STR_EXIT") == "sec10" and entry == "cross" and v == "plain20":   # the live bot's 10-second exit (exit10.py)
        x10 = EXIT10.get(f"{e['date']}|{e['sym']}|{e['m']}")
        if x10 and x10[0] // 60 <= w[3]: w = (w[0], w[1], w[2], x10[0] // 60); qs = (x10[1], x10[2])
    sbx = {b[0]: b for b in day(e["sym"], e["date"])}
    stock_out = next((sbx[k][4] for k in range(w[3], w[3] - 5, -1) if k in sbx), None)
    import strength_at
    st_m = ct if entry == "close" else ct - 1   # the last closed minute before the buy
    x = strength_at.of(e["sym"], e["date"]).get(st_m)
    t_side = d2_side = None
    if x: t_side, d2_side = (x[0], x[1]) if side == "C" else (-x[0], x[2])
    sign = 1 if side == "C" else -1
    bars = day(e["sym"], e["date"]); pb = day(e["sym"], CAL[CAL.index(e["date"]) - 1])
    mv_open = sign * (spot / bars[0][1] - 1) / e["u"] if bars and bars[0][0] <= 5 else None
    mv_close = sign * (spot / pb[-1][4] - 1) / e["u"] if pb else None
    if not (entry == "cross" and os.environ.get("STR_BUY")): fill, waited = "usual", 0
    bx = {x[0]: x for x in bars}
    am = sign * (bx[e["m"]][4] / bx[e["m"] - 3][4] - 1) / e["u"] if e["m"] in bx and e["m"] - 3 in bx else None
    a_sec = (e["m"] + 1) * 60
    if "sec0" in e:   # an alert inside a minute (fast / early): its own second and price, the close that ended 3 minutes before
        a_sec, k = e["sec0"], (e["sec0"] - 180) // 60 - 1
        am = sign * (e["stock0"] / bx[k][4] - 1) / e["u"] if k in bx else None
    return dict(am=am, to_cross=sec - a_sec, alert_sec=a_sec, src=e.get("src", ""), fill=fill, waited=waited, entry=entry, v=v, date=e["date"], sym=e["sym"], minute=e["m"], buy=buy, sell=qs[0], ct=ct, bm=ct, xm=w[3], delta=delta,
                t=t_side, d2=d2_side, mv_open=mv_open, mv_close=mv_close, side=side, mid_in=mid_in,
                mid_out=(qs[0] / (1 - LF.SH) if BARS and qs[0] > 0.0101 else (qs[0] + qs[1]) / 2),   # the model's mid at the sale
                stock_in=stock_in, stock_out=stock_out)


def main():
    step = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    ev_file = os.path.join(OUT, f"events{TAG}.json")
    if step == "list":
        if os.environ.get("SEC_ALERT") == "fast": ev = fast_events()
        else:
            if os.environ.get("SEC_SYMS"):   # SEC_SYMS=A,B,C: the alerts of these names only (P["universe"] for this list)
                P["universe"] = os.environ["SEC_SYMS"].split(",")
            jobs = TW.days()
            if os.environ.get("SEC_LATE"):   # every day with an expiry 2-7 days out, kind "l" (with SEC_FIRST / SEC_LAST)
                top = P["universe"] if os.environ.get("SEC_SYMS") else json.load(open(os.path.join(HERE, "strangle_rank.json")))[:int(os.environ.get("STR_TOP", "50"))]
                pairs = [(s, d) for s in top for i, d in enumerate(CAL) if d >= FROM and i >= 21]
                with mp.Pool(8) as pool: exps = pool.starmap(WC.late_expiry, pairs, chunksize=16)
                jobs = [(d, s, "l") for (s, d), x in zip(pairs, exps) if x]
            if os.environ.get("SEC_WEEK"):   # only the days with no 0/1 DTE but an expiry later that week
                top = P["universe"] if os.environ.get("SEC_SYMS") else json.load(open(os.path.join(HERE, "strangle_rank.json")))[:int(os.environ.get("STR_TOP", "50"))]
                with mp.Pool(8) as pool: kinds = pool.map(WC.kind, [(s, d) for s in top for i, d in enumerate(CAL) if d >= FROM and i >= 21], chunksize=16)
                jobs = [(d, s, "w") for (s, d), k in zip([(s, d) for s in top for i, d in enumerate(CAL) if d >= FROM and i >= 21], kinds) if k == "w"]
            with mp.Pool(8) as pool: res = pool.map(events_of, jobs, chunksize=8)
            ev = [e for r in res for e in r]
        if os.environ.get("STR_TOP"):
            top = set(json.load(open(os.path.join(HERE, "strangle_rank.json")))[:int(os.environ["STR_TOP"])])
            if os.environ.get("STR_FAV"): top |= set(P["universe_fav"])   # and every favorite
            ev = [e for e in ev if e["sym"] in top]
        json.dump(ev, open(ev_file, "w")); print(len(ev), "alerts"); return
    ev = json.load(open(ev_file))
    if step == "stock":
        with ThreadPoolExecutor(40) as ex:
            for i, _ in enumerate(ex.map(fetch_stock, ev)):
                if i % 200 == 0: print(i, "/", len(ev), flush=True)
        return
    pk_file = os.path.join(OUT, f"picks{TAG}{WTAG}{KTAG}.json")
    if step == "pick":
        with mp.Pool(8) as pool: trig = pool.map(triggers, ev, chunksize=8)
        with mp.Pool(8) as pool: picks = pool.map(pick_for, list(zip(ev, trig)), chunksize=4)
        json.dump([dict(t=t, p={f"{k[0]}|{k[1]}": x for k, x in p.items()}) for t, p in zip(trig, picks)], open(pk_file, "w"))
        print(sum(len(p) for p in picks), "picks"); return
    pk = json.load(open(pk_file))
    for add in (os.environ.get("SEC_ADD_TAG", "").split(",") if step == "run" else []):   # SEC_ADD_TAG=3y50w[,tag...]: more alerts, one account
        if not add: continue
        ev2 = json.load(open(os.path.join(OUT, f"events{add}.json"))); pk2 = json.load(open(os.path.join(OUT, f"picks{add}{WTAG}{KTAG}.json")))
        for e2 in ev2: e2["src"] = add
        if os.environ.get("SEC_ADD_NEW_ONLY"):   # only the added list's names the base list does not have (no alert twice)
            have = {e["sym"] for e in ev}
            keep = [i for i, e in enumerate(ev2) if e["sym"] not in have]
            ev2, pk2 = [ev2[i] for i in keep], [pk2[i] for i in keep]
        ev += ev2; pk += pk2
    if step == "option2":   # the limit-buy test's books (cross, live 0.20 rule)
        jobs = sorted({(i, pk[i]["p"]["cross|plain20"][0], pk[i]["t"]["cross"][0]) for i in range(len(ev)) if "cross|plain20" in pk[i]["p"]})
        with ThreadPoolExecutor(40) as ex:
            for n, _ in enumerate(ex.map(lambda j: fetch_opt2((ev[j[0]], j[1], j[2])), jobs)):
                if n % 200 == 0: print(n, "/", len(jobs), flush=True)
        return
    if step == "option":
        jobs = sorted({(i, x[0], pk[i]["t"][k.split("|")[0]][0]) for i in range(len(ev)) for k, x in pk[i]["p"].items() if not k.startswith("close") and k in os.environ.get("SEC_OPT_ONLY", k)})   # SEC_OPT_ONLY="cross|plain20": only those
        if os.environ.get("SEC_OPT_SYMS"):   # only these names' option windows
            keep_syms = set(os.environ["SEC_OPT_SYMS"].split(","))
            jobs = [j for j in jobs if ev[j[0]]["sym"] in keep_syms]
        if os.environ.get("SEC_OPT_CROSS_MAX"):   # only alerts whose stock crosses within this many seconds (less to download)
            a_sec = lambda e: e.get("sec0", (e["m"] + 1) * 60)
            jobs = [j for j in jobs if j[2] - a_sec(ev[j[0]]) <= int(os.environ["SEC_OPT_CROSS_MAX"])]
        if os.environ.get("SEC_OPT_AM_MIN"):   # only alerts whose burst points the side's way at least this much
            def am_ok(i):
                e, side = ev[i], pk[i]["t"]["cross"][1]
                sb = {b[0]: b[4] for b in day(e["sym"], e["date"])}
                if "sec0" in e:   # an alert inside a minute: its own price against the close that ended 3 minutes before (as trade())
                    k = (e["sec0"] - 180) // 60 - 1
                    if k not in sb: return False
                    return (1 if side == "C" else -1) * (e["stock0"] / sb[k] - 1) / e["u"] >= float(os.environ["SEC_OPT_AM_MIN"])
                if e["m"] not in sb or e["m"] - 3 not in sb: return False
                return (1 if side == "C" else -1) * (sb[e["m"]] / sb[e["m"] - 3] - 1) / e["u"] >= float(os.environ["SEC_OPT_AM_MIN"])
            jobs = [j for j in jobs if am_ok(j[0])]
        print(len(jobs), "option windows to fetch", flush=True)
        with ThreadPoolExecutor(40) as ex:
            for n, _ in enumerate(ex.map(lambda j: fetch_opt((ev[j[0]], j[1], j[2])), jobs)):
                if n % 200 == 0: print(n, "/", len(jobs), flush=True)
        return
    if step == "run" and os.environ.get("SEC_DTE_DAYS"):   # SEC_DTE_DAYS=2: of the same-week alerts only those this many days to expiry
        want = {int(x) for x in os.environ["SEC_DTE_DAYS"].split(",")}
        dte = lambda e: (datetime.fromisoformat(e["nxt"]) - datetime.fromisoformat(e["date"])).days
        keep = [i for i, e in enumerate(ev) if e.get("kind") != "w" or dte(e) in want]
        ev, pk = [ev[i] for i in keep], [pk[i] for i in keep]
    if step == "run":
        import news_filter as nf
        top = set(json.load(open(os.path.join(HERE, "strangle_rank.json")))[:int(os.environ.get("STR_TOP", "999"))]) if os.environ.get("STR_TOP") else None
        jobs = [(ev[i], k.split("|")[0], k.split("|")[1], x[0], x[1], pk[i]["t"][k.split("|")[0]]) for i in range(len(ev)) for k, x in pk[i]["p"].items() if (top is None or ev[i]["sym"] in top) and ev[i]["sym"] not in os.environ.get("STR_EXCL", "").split(",")]
        if os.environ.get("STR_ALERT_SECS"):   # STR_ALERT_SECS=600,12600: only alerts in that part of the day (seconds after 9:30)
            lo_s, hi_s = map(int, os.environ["STR_ALERT_SECS"].split(","))
            jobs = [j for j in jobs if lo_s <= j[0].get("sec0", (j[0]["m"] + 1) * 60) <= hi_s]
        if os.environ.get("STR_TO"): jobs = [j for j in jobs if j[0]["date"] <= os.environ["STR_TO"]]
        with mp.Pool(8) as pool: T = [t for t in pool.map(trade, jobs, chunksize=8) if t]
        OWN = {}
        if os.environ.get("STR_SRC_ENTRY"):   # "e_shock15=hold5:300" (the user 2026-10-29, "all together"): that tag's alerts
            # enter at hold5 within 300 s with no burst, shown as "cross"; every other alert keeps the cross and its burst
            for spec in os.environ["STR_SRC_ENTRY"].split(","):
                tag, rule = spec.split("="); ent, mx = rule.split(":"); OWN[tag] = (ent, int(mx))
            T = [t for t in T if t["src"] not in OWN] + [dict(t, entry="cross") for t in T if t["src"] in OWN and t["entry"] == OWN[t["src"]][0] and t["to_cross"] <= OWN[t["src"]][1]]
        if os.environ.get("STR_AM_MIN"):   # the burst's own 3-minute move (to the alert minute), the side's way, x S30
            # STR_AM_SKIP_FAST=1: alerts inside a minute (the shock rule) need no burst; the minute alerts keep it
            fast = {(e["date"], e["sym"], e["m"]) for e in ev if "sec0" in e} if os.environ.get("STR_AM_SKIP_FAST") else set()
            T = [t for t in T if t["src"] in OWN or (t["date"], t["sym"], t["minute"]) in fast or (t["am"] is not None and t["am"] >= float(os.environ["STR_AM_MIN"]))]
        if os.environ.get("STR_AM_MIN_W"):   # a stronger burst for the same-week (2-4 DTE) alerts only
            wk = {(e["date"], e["sym"], e["m"]) for e in ev if e.get("kind") == "w"}
            T = [t for t in T if t["src"] in OWN or (t["date"], t["sym"], t["minute"]) not in wk or (t["am"] is not None and t["am"] >= float(os.environ["STR_AM_MIN_W"]))]
        if os.environ.get("STR_CROSS_MAX"):   # seconds from the alert to the cross
            T = [t for t in T if t["src"] in OWN or t["to_cross"] <= int(os.environ["STR_CROSS_MAX"])]
        MIXES = []
        if os.environ.get("STR_MIX"):   # the user 2026-10-29: far delta when the volume is huge and the cross fast, else near
            # STR_MIX="name=far:near:vmin:cmax;...", STR_VOL_FILE: {"sym|date|alert second": volume multiple}
            vol = json.load(open(os.environ["STR_VOL_FILE"]))
            by_key = {}
            for t in T: by_key.setdefault((t["date"], t["sym"], t["minute"], t["entry"]), {})[t["v"]] = t
            for spec in os.environ["STR_MIX"].split(";"):
                name, rule = spec.split("="); far, near, vmin, cmax = rule.split(":")
                MIXES.append(name)
                for (d, sy, mi, en), vs in by_key.items():
                    any_t = next(iter(vs.values()))
                    huge = vol.get(f"{sy}|{d}|{any_t['alert_sec']}", 0) >= float(vmin) and any_t["to_cross"] <= float(cmax)
                    pick = vs.get(far if huge else near)
                    if pick: T.append(dict(pick, v=name, far=int(huge)))
        rows = [dict(date=d, sym=s, minute=0, right="C") for d, s in {(t["date"], t["sym"]) for t in T}]
        nf.features(rows)
        skip = {(r["date"], r["sym"]) for r in rows if r["e_next"] == 0 or (r["pre_rvol"] is not None and r["pre_rvol"] >= 4)}
        if os.environ.get("STR_DUMP_ALL"):   # every simulated trade before the filters and the account (cross, live rule)
            json.dump([dict(t, news_skip=int((t["date"], t["sym"]) in skip)) for t in T if t["entry"] == "cross" and t["v"] == "plain20"],
                      open(os.environ["STR_DUMP_ALL"], "w"), default=str)
        spans = (("12 months", "2025-10-23", "9999"), ("6 months", "2026-04-23", "9999"))
        if TAG: spans = ((f"3 years ({FROM} on)", FROM, "9999"), ("2024", "2024", "2025"), ("2025", "2025", "2026"), ("2026", "2026", "9999")) + spans
        split = os.environ.get("STR_SPLIT", "2025-07")   # the first month of the check half
        if TAG: spans += ((f"tune (to {split})", FROM, split), (f"check ({split} on)", split, "9999"))
        FILTERS = {"all": lambda t: True}
        if os.environ.get("STR_FILTERS"):
            ok = lambda t, k: t[k] is not None
            FILTERS.update({
                "t >= 0 (agrees)": lambda t: ok(t, "t") and t["t"] >= 0,
                "t >= 1.2": lambda t: ok(t, "t") and t["t"] >= 1.2,
                "t >= 1.8": lambda t: ok(t, "t") and t["t"] >= 1.8,
                "D2 >= 1.0": lambda t: ok(t, "d2") and t["d2"] >= 1.0,
                "D2 >= 1.5": lambda t: ok(t, "d2") and t["d2"] >= 1.5,
                "t >= 1.2 and D2 >= 1.5": lambda t: ok(t, "t") and ok(t, "d2") and t["t"] >= 1.2 and t["d2"] >= 1.5,
                "t >= 1.8, or t >= 1.2 and D2 >= 1.5 (Main bot 2.6)": lambda t: ok(t, "t") and (t["t"] >= 1.8 or (t["t"] >= 1.2 and ok(t, "d2") and t["d2"] >= 1.5)),
                "t < 0 (disagrees)": lambda t: ok(t, "t") and t["t"] < 0,
            })
            if os.environ.get("STR_FILTERS") == "move":
                FILTERS = {"all": lambda t: True, "t >= 0": lambda t: ok(t, "t") and t["t"] >= 0}
                for k in (2, 3, 4, 6):
                    FILTERS[f"skip open move >= {k}"] = (lambda k: lambda t: ok(t, "mv_open") and t["mv_open"] < k)(k)
                    FILTERS[f"skip day move >= {k}"] = (lambda k: lambda t: ok(t, "mv_close") and t["mv_close"] < k)(k)
                for k in (2, 3, 4, 6):
                    FILTERS[f"t >= 0, skip open move >= {k}"] = (lambda k: lambda t: ok(t, "t") and t["t"] >= 0 and ok(t, "mv_open") and t["mv_open"] < k)(k)
                    FILTERS[f"t >= 0, skip day move >= {k}"] = (lambda k: lambda t: ok(t, "t") and t["t"] >= 0 and ok(t, "mv_close") and t["mv_close"] < k)(k)
            VERS, ENTS = ("plain20",), ("cross",)
            if os.environ.get("STR_FILTERS") != "move": VERS, ENTS = ("plain20",), ("close", "cross")
        else: VERS, ENTS = VERSIONS + tuple(MIXES), ENTRIES
        GROUPS = {"": lambda t: True}
        if os.environ.get("STR_GROUPS"):
            t15 = set(json.load(open(os.path.join(HERE, "strangle_rank.json")))[:15])
            GROUPS = {"all: ": lambda t: True, "top 15: ": lambda t: t["sym"] in t15, "the rest: ": lambda t: t["sym"] not in t15}
        if os.environ.get("STR_WITHOUT_DAYS"):   # STR_WITHOUT_DAYS=2025-10-10: each filter again without those days
            out_days = set(os.environ["STR_WITHOUT_DAYS"].split(","))
            GROUPS = {**{g: f for g, f in GROUPS.items()}, **{f"{g}without {'/'.join(sorted(out_days))}: ": (lambda f: lambda t: f(t) and t["date"] not in out_days)(f) for g, f in GROUPS.items()}}
        # STR_ACCOUNTS="live,free1,free2,free3": several accounts in one run (live limits, or no limits at x% a trade)
        ACCTS = [("", bool(os.environ.get("STR_NO_LIMITS")), float(os.environ.get("STR_SIZE", "1")))]
        if os.environ.get("STR_ACCOUNTS"):
            # "live" = live limits at STR_SIZE; "liveN" / "freeN" = live limits / no limits at N% a trade
            acct_size = lambda a: float(a.lstrip("livefr") or os.environ.get("STR_SIZE", "1"))
            # "flatN" = no limits, but one trade at a time a stock (no second buy of a stock while its first is open)
            ACCTS = [(f"[{a}] ", a.startswith("free") or a.startswith("flat"), float(a.lstrip("livefratl") or os.environ.get("STR_SIZE", "1"))) for a in os.environ["STR_ACCOUNTS"].split(",")]
        DIAG = []
        for lab, lo, hi in spans:
            print(f"\n### {lab}\n\n| Filter | Version | Entry | Trades | Avg per trade | End ($100K), worst drop |\n|---|---|---|---|---|---|")
            for gname, in_group in GROUPS.items():
             for fname0, keep_if0 in FILTERS.items():
              fname = gname + fname0
              keep_if = (lambda a, b: lambda t: a(t) and b(t))(in_group, keep_if0)
              for v in VERS:
                for entry in ENTS:
                    S = [t for t in T if t["v"] == v and t["entry"] == entry and lo <= t["date"] < hi and (t["date"], t["sym"]) not in skip and keep_if(t)]
                    by = {}
                    for t in S: by.setdefault((t["date"], t["sym"]), []).append(dict(minute=t["minute"], trade=t))
                    fname1 = gname + fname0
                    for alab, no_limits, size in ACCTS:
                      fname = alab + fname1
                      keep = []
                      for k, evs in by.items():
                          for x in TW.pick(dict(events=sorted(evs, key=lambda z: z["minute"])), "open" if no_limits and "flat" not in alab else "flat")[:int(os.environ.get("STR_PER_STOCK", "2"))]: keep.append(x["trade"])
                      if no_limits: eL, dL, R, _, _ = D.account(keep, size, 2)   # no day loss, trade, open or per-stock limit
                      else: eL, dL, R, _, _ = D.account(keep, size, 2, loss=7.5, max_trades=int(os.environ.get("STR_MAX_TRADES", "15")), max_open=int(os.environ.get("STR_MAX_OPEN", "5")))
                      avg = sum((r["sell"] * 100 - 0.62) / (r["buy"] * 100 + 0.62) - 1 for r in R) / max(1, len(R))
                      if os.environ.get("STR_DETAIL") and v == "plain20" and entry == "cross" and lab == "12 months":
                          import collections
                          by_s = collections.defaultdict(list)
                          for r in R: by_s[r["sym"]].append(r["pnl"])
                          for sy, ps in sorted(by_s.items(), key=lambda x: -len(x[1])): print(f"  {sy}: {len(ps)} trades, {sum(p > 0 for p in ps)} won, ${sum(ps):,.0f}")
                          print("  months:", dict(sorted(collections.Counter(r["date"][:7] for r in R).items())))
                      if os.environ.get("STR_DUMP") and v == "plain20" and entry != "close" and lab.startswith("3 years") and fname in ("all", "all: all"):
                          dp = os.environ["STR_DUMP"]   # the kept trades, for a chart; cross at STR_DUMP, a hold at <name>_<entry>.json
                          if entry != "cross": dp = dp.replace(".json", f"_{entry}.json")
                          json.dump(R, open(dp, "w"), default=str)
                      if os.environ.get("STR_DUMP_DIR") and v == "plain20" and entry == "cross" and lab.startswith("3 years"):
                        slug = re.sub(r"[^a-z0-9]+", "_", fname.lower()).strip("_")   # the kept trades of each account and filter
                        json.dump(R, open(os.path.join(os.environ["STR_DUMP_DIR"], f"{slug}.json"), "w"), default=str)
                      if os.environ.get("STR_DIAG") and v == "plain20" and entry == "cross" and R:
                          import statistics as stt
                          sg = lambda r: 1 if r["side"] == "C" else -1
                          stk = [sg(r) * (r["stock_out"] / r["stock_in"] - 1) for r in R if r["stock_out"] and r["stock_in"]]
                          mv = [(r["mid_out"] - r["mid_in"]) / r["buy"] for r in R]
                          cin = [(r["mid_in"] - r["buy"]) / r["buy"] for r in R]
                          cout = [(r["sell"] - r["mid_out"]) / r["buy"] for r in R]
                          com = [-2 * 0.62 / (r["buy"] * 100) for r in R]
                          tst = stt.mean(stk) / (stt.pstdev(stk) / len(stk) ** 0.5) if len(stk) > 1 and stt.pstdev(stk) else 0
                          DIAG.append(f"| {lab} | {fname} | {len(R)} | {100 * stt.mean(stk):+.3f}% (t {tst:.1f}, win {100 * sum(x > 0 for x in stk) / len(stk):.0f}%) | "
                                      f"{100 * stt.mean(mv):+.1f}% | {100 * stt.mean(cin):+.1f}% | {100 * stt.mean(cout):+.1f}% | {100 * stt.mean(com):+.1f}% | "
                                      f"{100 * stt.mean(r['sell'] / r['buy'] - 1 + c for r, c in zip(R, com)):+.1f}% | ${stt.median(r['buy'] for r in R):.2f} |")
                      print(f"| {fname} | {v} | {entry} | {len(R)} | {100 * avg:+.1f}% | ${eL:,.0f}, {100 * dL:.1f}% |", flush=True)
        if DIAG:
            print("\n| Span | Filter | Trades | Stock alone, a trade | Option move at mid | Paid over mid | Sold under mid | Commission | Net | Median price |")
            print("|---|---|---|---|---|---|---|---|---|---|")
            for line in DIAG: print(line)


if __name__ == "__main__": main()
