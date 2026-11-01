"""Indi's night book: every trade of his held overnight, with everything we have on it, for the "Indi's Nights" page.
The user 2026-11-01: "Show me all indi data in artifact - on click show me everything you got - in an easy way to read.
Graph, technical analys, resistance and support, volume, news, vs spy streight, his X comments. EVERYTHING".

Trades: his silexx account (data/local/x/ultrawavetrader-20*/actions.csv), any trade whose actions span two dates or
more (379, 2023 on; "late" = opened 15:00 New York or later). Per trade -> <out>/t/<id>.json:
  acts      his fills (time New York, kind, qty, price, the step's P&L, what he wrote with it)
  days      the day before, the entry day, and every day to his last sale (at most 3 after the entry)
  bars      the stock per day: regular hours 1-minute, pre-market and after-hours 5-minute (Alpaca SIP, raw prices)
  spy       SPY the same way (closes)
  opt       his contract, 1-minute (Alpaca options, Feb 2024 on)
  daily     ~1 year of daily bars to the entry day (raw)
  ta        SMA 20 / 50 / 200, RSI 14, ATR 14, 20-day and 52-week high / low, beta to SPY (60 days), the day's change,
            gap, range position, volume vs the 20-day average (to 15:57 and the whole day), the excess move vs SPY
  levels    support and resistance: swing highs / lows of the last 120 days (3 days each side, merged within half an
            ATR), the day before's high / low / close, the 20-day and 52-week high / low; nearest 4 each side
  feat      the nightly_feat.py measures of that stock-side-night when the stock is in its universe
  news      Alpaca / Benzinga headlines from the day before 16:00 to his last sale day 20:00
  earnings  report dates within a week (earnings.json)
  posts     his X posts in the window (threads.json): about the stock, and his top-level posts from the entry day 15:00
            to the next day 10:00 (the night's market talk)
<out>/list.json: one summary row per trade for the list and the overview.

  node --env-file=.env scripts/research/indi_bt/run.mjs indi_night_book.py <out dir>     (from the app repo root)
"""
import bisect, collections, csv, datetime as dt, glob, gzip, json, math, os, re, statistics as st, sys, urllib.parse
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import store

NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
OUT = sys.argv[1]
CACHE = os.path.join(OUT, "_cache"); os.makedirs(CACHE, exist_ok=True); os.makedirs(os.path.join(OUT, "t"), exist_ok=True)
X = "data/local/x"
CAL = store.calendar()


def cached(name, fn):
    p = os.path.join(CACHE, re.sub(r"[^A-Za-z0-9_.-]", "_", name) + ".json")
    if os.path.exists(p): return json.load(open(p))
    v = fn(); json.dump(v, open(p, "w")); return v


def pages(url, key):
    out, tok = [], None
    while True:
        u = url + (f"&page_token={tok}" if tok else "")
        r = store._get(u)
        out.append(r[key]); tok = r.get("next_page_token")
        if not tok: return out


def stock_bars(syms, d0, d1):
    s = dt.datetime.fromisoformat(f"{d0}T04:00").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = dt.datetime.fromisoformat(f"{d1}T20:00").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = (f"https://data.alpaca.markets/v2/stocks/bars?symbols={','.join(syms)}&timeframe=1Min&start={s}&end={e}"
           f"&limit=10000&adjustment=raw&feed=sip")
    got = collections.defaultdict(list)
    for p in pages(url, "bars"):
        for k, v in (p or {}).items(): got[k] += v
    return got


def opt_bars(occ, d0, d1):
    url = (f"https://data.alpaca.markets/v1beta1/options/bars?symbols={occ}&timeframe=1Min&start={d0}T13:00:00Z"
           f"&end={d1}T21:00:00Z&limit=10000")
    got = []
    try:
        for p in pages(url, "bars"): got += (p or {}).get(occ, [])
    except Exception: pass
    return got


def daily(sym):
    url = (f"https://data.alpaca.markets/v2/stocks/bars?symbols={sym}&timeframe=1Day&start=2021-06-01&end=2026-10-31"
           f"&limit=10000&adjustment=raw&feed=sip")
    got = []
    for p in pages(url, "bars"): got += (p or {}).get(sym, [])
    return [[b["t"][:10], b["o"], b["h"], b["l"], b["c"], b["v"]] for b in got]


def news(sym, d0, d1):
    s = dt.datetime.fromisoformat(f"{d0}T16:00").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = dt.datetime.fromisoformat(f"{d1}T20:00").replace(tzinfo=NY).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"https://data.alpaca.markets/v1beta1/news?symbols={sym}&start={s}&end={e}&limit=50&sort=asc&include_content=false"
    out = []
    for p in pages(url, "news"):
        for n in p or []:
            t = dt.datetime.fromisoformat(n["created_at"].replace("Z", "+00:00")).astimezone(NY)
            out.append(dict(t=t.strftime("%Y-%m-%d %H:%M"), h=n.get("headline", ""), s=(n.get("summary") or "")[:400],
                            src=n.get("source", ""), url=n.get("url") or "", syms=len(n.get("symbols") or [])))
    return out


def minute(ts):
    t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(NY)
    return t.strftime("%Y-%m-%d"), t.hour * 60 + t.minute - 570


def r2(x): return round(x, 4 if x < 5 else 2)


def pack(bars, keep_ohlcv=True):
    """-> {date: {"reg": [[m,o,h,l,c,v]] 1-min, "ext": [[m,o,h,l,c,v]] 5-min}} (m = minutes from 09:30)."""
    by = collections.defaultdict(lambda: {"reg": [], "x": collections.OrderedDict()})
    for b in bars:
        d, m = minute(b["t"])
        if 0 <= m < 390:
            by[d]["reg"].append([m, r2(b["o"]), r2(b["h"]), r2(b["l"]), r2(b["c"]), int(b["v"])] if keep_ohlcv else [m, r2(b["c"])])
        else:
            k = m // 5 * 5; x = by[d]["x"].get(k)
            if x is None: by[d]["x"][k] = [k, b["o"], b["h"], b["l"], b["c"], b["v"]]
            else: x[2] = max(x[2], b["h"]); x[3] = min(x[3], b["l"]); x[4] = b["c"]; x[5] += b["v"]
    out = {}
    for d, v in by.items():
        ext = [[k, r2(o), r2(h), r2(l), r2(c), int(vv)] if keep_ohlcv else [k, r2(c)] for k, o, h, l, c, vv in v["x"].values()]
        out[d] = {"reg": v["reg"], "ext": ext}
    return out


def sma(xs, n): return sum(xs[-n:]) / n if len(xs) >= n else None


def rsi(cl, n=14):
    if len(cl) < n + 1: return None
    g = l = 0.0
    for i in range(1, n + 1):
        ch = cl[i] - cl[i - 1]; g += max(ch, 0); l += max(-ch, 0)
    g /= n; l /= n
    for i in range(n + 1, len(cl)):
        ch = cl[i] - cl[i - 1]; g = (g * (n - 1) + max(ch, 0)) / n; l = (l * (n - 1) + max(-ch, 0)) / n
    return 100.0 if l == 0 else 100 - 100 / (1 + g / l)


def atr(D, n=14):
    tr = [max(D[i][2] - D[i][3], abs(D[i][2] - D[i - 1][4]), abs(D[i][3] - D[i - 1][4])) for i in range(1, len(D))]
    return sum(tr[-n:]) / n if len(tr) >= n else None


def beta(D, S, n=60):
    sc = {d[0]: d[4] for d in S}
    pts = [(D[i][4] / D[i - 1][4] - 1, sc[D[i][0]] / sc[D[i - 1][0]] - 1) for i in range(max(1, len(D) - n), len(D))
           if D[i][0] in sc and D[i - 1][0] in sc]
    if len(pts) < 20: return 1.0
    mx = st.fmean(p[1] for p in pts); my = st.fmean(p[0] for p in pts)
    vx = sum((p[1] - mx) ** 2 for p in pts)
    return sum((p[1] - mx) * (p[0] - my) for p in pts) / vx if vx else 1.0


def levels(D, px, a):
    """Swing highs / lows of the last 120 sessions (3 each side), merged within half an ATR; nearest 4 each side."""
    W = D[-120:]; out = []
    for i in range(3, len(W) - 3):
        if W[i][2] == max(x[2] for x in W[i - 3:i + 4]): out.append((W[i][2], "swing high", W[i][0]))
        if W[i][3] == min(x[3] for x in W[i - 3:i + 4]): out.append((W[i][3], "swing low", W[i][0]))
    out.sort()
    merged = []
    for p, why, d in out:
        if merged and a and p - merged[-1]["p"] <= 0.5 * a:
            m = merged[-1]; m["touch"] += 1; m["p"] = round((m["p"] * (m["touch"] - 1) + p) / m["touch"], 2); m["last"] = max(m["last"], d)
        else: merged.append(dict(p=round(p, 2), why=why, touch=1, last=d))
    sup = sorted([m for m in merged if m["p"] < px], key=lambda m: -m["p"])[:4]
    res = sorted([m for m in merged if m["p"] >= px], key=lambda m: m["p"])[:4]
    for m in sup: m["kind"] = "support"
    for m in res: m["kind"] = "resistance"
    return sup + res


def main():
    A = []
    for f in sorted(glob.glob(f"{X}/ultrawavetrader-20[0-9][0-9]/actions.csv")):
        A += [a for a in csv.DictReader(open(f)) if a["account"] == "silexx"]
    byt = collections.defaultdict(list)
    for a in A: byt[a["trade"]].append(a)
    man = {}
    for f in glob.glob(f"{X}/ultrawavetrader-20[0-9][0-9]/manage.csv"):
        for r in csv.DictReader(open(f)): man[r["trade"]] = r
    posts = []
    for f in glob.glob(f"{X}/ultrawavetrader-20[0-9][0-9]/threads.json"):
        for th in json.load(open(f)):
            for p in th["posts"]:
                t = dt.datetime.fromisoformat(p["time"].replace("Z", "+00:00")).astimezone(NY)
                posts.append((t.strftime("%Y-%m-%d %H:%M"), p["text"], p["id"], p.get("media") or []))
    posts = sorted({p[2]: p for p in posts}.values())
    ptimes = [p[0] for p in posts]
    earn = json.load(open("data/local/x/bt/earnings.json"))
    feat = {}
    with gzip.open("data/local/x/bt/nightly_feat.csv.gz", "rt") as fh:
        for r in csv.DictReader(fh): feat[(r["sym"], r["date"], r["side"])] = r
    held = []
    for k, v in byt.items():
        v.sort(key=lambda a: (a["date"], a["time_from"] or "99"))
        if len({a["date"] for a in v}) > 1 and v[0]["date"] in CAL: held.append((k, v))
    held.sort(key=lambda kv: (kv[1][0]["date"], kv[1][0]["time_from"]))
    print(len(held), "trades held overnight", flush=True)
    spy_daily = cached("daily_SPY", lambda: daily("SPY"))
    rows = []
    for n, (k, v) in enumerate(held):
        con = v[0]["contract"].split()   # "IWM 2026-08-13 305C"
        sym, exp, ks = con[0], con[1], con[2]
        right, strike = ks[-1], float(ks[:-1])
        d0 = v[0]["date"]; last = max(a["date"] for a in v)
        i0 = CAL.index(d0)
        il = bisect.bisect_right(CAL, last) - 1
        days = CAL[i0 - 1: min(il, i0 + 3) + 1]
        try:
            B = cached(f"bars_{sym}_{days[0]}_{days[-1]}", lambda: stock_bars([sym, "SPY"], days[0], days[-1]))
        except Exception as e:
            print("bars failed", k, e); continue
        if not B.get(sym): print("no bars", k); continue
        stock = pack(B[sym]); spy = pack(B["SPY"], keep_ohlcv=False)
        occ = f"{sym}{exp[2:4]}{exp[5:7]}{exp[8:10]}{right}{int(round(strike * 1000)):08d}"
        ob = cached(f"opt_{occ}_{d0}_{days[-1]}", lambda: opt_bars(occ, d0, days[-1])) if d0 >= "2024-02-01" else []
        opt = collections.defaultdict(list)
        for b in ob:
            d, m = minute(b["t"])
            if 0 <= m < 390: opt[d].append([m, r2(b["c"]), int(b["v"])])
        Dall = cached(f"daily_{sym}", lambda: daily(sym))
        D = [x for x in Dall if x[0] < d0]
        Dd = next((x for x in Dall if x[0] == d0), None)
        cl = [x[4] for x in D]
        reg = stock.get(d0, {}).get("reg", [])
        px = next((b[4] for b in reversed(reg) if b[0] <= 387), None) or (reg[-1][4] if reg else None)
        if px is None or len(D) < 30: print("thin", k); continue
        a14 = atr(D); prev = D[-1]
        vol_to = sum(b[5] for b in reg if b[0] <= 387)
        av20 = st.fmean(x[5] for x in D[-20:])
        bet = 1 if right == "C" else -1
        sreg = {b[0]: b[1] for b in spy.get(d0, {}).get("reg", [])}
        sprev = next((x[4] for x in spy_daily if x[0] == D[-1][0]), None)
        sp = next((sreg[m] for m in range(387, -1, -1) if m in sreg), None)
        b60 = beta(D, spy_daily)
        dchg = px / prev[4] - 1; schg = (sp / sprev - 1) if sp and sprev else 0
        hi, lo = max(b[2] for b in reg if b[0] <= 387), min(b[3] for b in reg if b[0] <= 387)
        nxt = CAL[i0 + 1] if i0 + 1 < len(CAL) else None
        nreg = stock.get(nxt, {}).get("reg", []) if nxt else []
        dclose = reg[-1][4]
        ta = dict(px=px, prevC=prev[4], prevH=prev[2], prevL=prev[3], open=reg[0][1], dayChg=dchg, spyChg=schg, beta=round(b60, 2),
                  excess=dchg - b60 * schg, gap=reg[0][1] / prev[4] - 1, rangePos=(px - lo) / (hi - lo) if hi > lo else 0.5,
                  hi=hi, lo=lo, sma20=sma(cl, 20), sma50=sma(cl, 50), sma200=sma(cl, 200), rsi14=rsi(cl[-120:] + [px]),
                  atr=a14, atrPct=a14 / px if a14 else None, hi20=max(x[2] for x in D[-20:]), lo20=min(x[3] for x in D[-20:]),
                  hi52=max(x[2] for x in D[-250:]), lo52=min(x[3] for x in D[-250:]), avgVol20=av20, volTo1557=vol_to,
                  rvol1557=vol_to / av20 if av20 else None, dayVol=Dd[5] if Dd else None, close=dclose,
                  nextOpen=nreg[0][1] if nreg else None, nextGap=(bet * (nreg[0][1] / dclose - 1)) if nreg else None,
                  next10=(bet * (next((b[4] for b in nreg if b[0] >= 30), nreg[-1][4]) / dclose - 1)) if nreg else None)
        lv = levels(D, px, a14)
        for p, why in ((prev[2], "yesterday's high"), (prev[3], "yesterday's low"), (prev[4], "yesterday's close"),
                       (ta["hi20"], "20-day high"), (ta["lo20"], "20-day low"), (ta["hi52"], "52-week high"), (ta["lo52"], "52-week low")):
            lv.append(dict(p=round(p, 2), why=why, kind="support" if p < px else "resistance", touch=0, last=""))
        acts = []
        for a in v:
            acts.append(dict(d=a["date"], t=a["time_from"], kind=a["action"], side=a["side"], qty=int(float(a["qty"] or 0)),
                             px=float(a["avg_price"] or 0), pnl=float(a["realized_step"]) if a["realized_step"] else None,
                             post=a["his_post"] or ""))
        w0, w1 = f"{days[0]} 16:00", f"{days[-1]} 20:00"
        rx = re.compile(rf"(?<![A-Za-z])\$?{re.escape(sym)}(?![A-Za-z])", re.I)
        ps = []
        for p in posts[bisect.bisect_left(ptimes, f"{d0} 09:00"): bisect.bisect_right(ptimes, f"{last} 16:30")]:
            about = bool(rx.search(p[1]))
            night = f"{d0} 15:00" <= p[0] <= f"{nxt} 10:00" and not p[1].startswith("@")
            if about or night: ps.append(dict(t=p[0], text=p[1], id=p[2], about=about, media=len(p[3])))
        about_n = sum(p["about"] for p in ps)
        ps = [p for p in ps if p["about"]] + [p for p in ps if not p["about"]][:30]
        ps.sort(key=lambda p: p["t"])
        try: nw = cached(f"news_{sym}_{days[0]}_{days[-1]}", lambda: news(sym, days[0], days[-1]))
        except Exception as e: print("news failed", k, e); nw = []
        er = [e for e in earn.get(sym, []) if (dt.date.fromisoformat(d0) - dt.timedelta(days=7)).isoformat() <= e[0] <= (dt.date.fromisoformat(last) + dt.timedelta(days=7)).isoformat()]
        f = feat.get((sym, d0, right))
        m = man.get(k, {})
        cost = float(m["cost"]) if m.get("cost") else acts[0]["px"]
        pnl = float(m["pnl"]) if m.get("pnl") else sum(a["pnl"] or 0 for a in acts)
        ret = float(m["ret"]) / 100 if m.get("ret") else None
        tid = re.sub(r"[^A-Za-z0-9_.-]", "_", k)
        T = dict(id=tid, trade=k, sym=sym, right=right, strike=strike, exp=exp, contract=v[0]["contract"], acts=acts, days=days,
                 entry=d0, last=last, bars=stock, spy=spy, opt=opt, daily=Dall[max(0, len(D) - 260): len(D) + 1 + len(days)],
                 ta=ta, levels=lv, feat={kk: f[kk] for kk in f if kk not in ("sym", "date", "side")} if f else None,
                 news=nw, earnings=er, posts=ps, pnl=pnl, ret=ret, cost=cost)
        json.dump(T, open(os.path.join(OUT, "t", tid + ".json"), "w"), separators=(",", ":"))
        rows.append(dict(id=tid, sym=sym, right=right, strike=strike, exp=exp, entry=d0, time=v[0]["time_from"], last=last,
                         nights=CAL.index(last) - i0 if last in CAL else len(days) - 2, late=(v[0]["time_from"] or "") >= "15:00",
                         qty=acts[0]["qty"], cost=cost, pnl=pnl, ret=ret, dayChg=dchg, excess=ta["excess"], rangePos=ta["rangePos"],
                         rvol=ta["rvol1557"], gap=ta["gap"], nextGap=ta["nextGap"], next10=ta["next10"], rsi=ta["rsi14"],
                         above50=(px > ta["sma50"]) if ta["sma50"] else None, news=len(nw), postsAbout=about_n,
                         earn=bool(er), t=float(f["t"]) if f and f["t"] else None, first=(acts[0]["post"] or "")[:160],
                         dte=(dt.date.fromisoformat(exp) - dt.date.fromisoformat(d0)).days))
        if n % 20 == 0: print(n, k, flush=True)
    json.dump(rows, open(os.path.join(OUT, "list.json"), "w"), separators=(",", ":"))
    print(len(rows), "trades written to", OUT)


if __name__ == "__main__":
    main()
