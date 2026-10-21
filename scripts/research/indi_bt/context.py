"""What surrounded his entries: earnings, the market (SPY, QQQ, VIXY, breadth), the pre-market, the sector and
peers, the stock's own recent days, macro days, and his own recent trading. 2023 - Oct 2026, his 40 stocks.

Rows: every entry of his (main account, first open of a trade, at his minute and direction), and a base of
every stock-day at a minute drawn from his entry minutes, in the direction of the stock's move at that minute.
Each row also gets the stock's move from that minute to the close and to the next open (both ways a base can
be compared), his real P&L and the P&L of our exit (your stop, $10K, 2024+).

  python3 context.py build      -> data/local/x/bt/context_rows.csv   (from the repo root)
  python3 context.py report     -> printed tables
"""
import bisect, collections, csv, datetime as dt, json, os, random, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar, db
from signals import series

B = "data/local/x/bt"
GROUP = {"semis": (["NVDA", "SMCI", "AMD", "ARM", "AVGO", "QCOM", "MU"], "SMH"),
         "megatech": (["AAPL", "MSFT", "ORCL", "IBM", "GOOGL", "META", "AMZN"], "XLK"),
         "crypto": (["MSTR", "COIN", "IBIT", "HOOD", "CRCL"], "BITO"),
         "auto": (["TSLA", "CVNA", "QS"], "XLY"),
         "china": (["BIDU", "PDD"], "KWEB"),
         "health": (["MRNA", "HIMS"], "XBI"),
         "software": (["PLTR", "APP", "AI", "UPST", "AFRM", "SOFI", "ROKU", "RBLX", "NBIS", "CRWV"], "IGV"),
         "other": (["ASTS", "GME", "BA", "FSLR"], "ARKK")}
SECT = {s: (g, etf) for g, (ss, etf) in GROUP.items() for s in ss}
# FOMC decision days and CPI release days (from public calendars; written by hand)
FOMC = set("2023-02-01 2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13 2024-01-31 2024-03-20 2024-05-01 "
           "2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18 2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 "
           "2025-10-29 2025-12-10 2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16".split())
CPI = set("2023-01-12 2023-02-14 2023-03-14 2023-04-12 2023-05-10 2023-06-13 2023-07-12 2023-08-10 2023-09-13 2023-10-12 2023-11-14 "
          "2023-12-12 2024-01-11 2024-02-13 2024-03-12 2024-04-10 2024-05-15 2024-06-12 2024-07-11 2024-08-14 2024-09-11 2024-10-10 "
          "2024-11-13 2024-12-11 2025-01-15 2025-02-12 2025-03-12 2025-04-10 2025-05-13 2025-06-11 2025-07-15 2025-08-12 2025-09-11 "
          "2025-10-24 2025-12-18".split())


def his_entries():
    real = collections.Counter(); first = {}
    for y in ("2023", "2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx": continue
            if r["realized_step"]: real[r["trade"]] += float(r["realized_step"])
            if r["action"] == "open" and r["time_from"] and r["trade"] not in first:
                und, exp, sr = r["contract"].rsplit(" ", 2)
                if sr.endswith("S") or sr[-1] not in "CP": continue
                hh, mm = map(int, r["time_from"][:5].split(":"))
                first[r["trade"]] = dict(date=r["date"], sym=und, right=sr[-1], minute=min(389, max(0, hh * 60 + mm - 570)),
                                         dte=(dt.date.fromisoformat(exp) - dt.date.fromisoformat(r["date"])).days)
    out = []
    for t, e in first.items():
        e.update(trade=t, real=round(real[t])); out.append(e)
    return out


def reaction_days(cal, summ):
    """Trading day the market reacts to each report: same day if before the open, next day if after the close,
    otherwise whichever of the two gapped more."""
    E = json.load(open(f"{B}/earnings.json")); out = collections.defaultdict(list)
    for s, rows in E.items():
        if s not in P["universe"]: continue
        for d, t in rows:
            i = bisect.bisect_left(cal, d)
            if i >= len(cal) - 1: continue
            same = cal[i] if cal[i] == d else None
            nxt = cal[i + 1] if same else cal[i]
            if t == "time-pre-market" and same: r = same
            elif t == "time-after-hours" or not same: r = nxt
            else: r = max((same, nxt), key=lambda x: abs((summ.get((s, x)) or {}).get("gap", 0)))
            out[s].append(cal.index(r))
    return {s: sorted(set(v)) for s, v in out.items()}


def summaries(cal):
    """Per stock-day: open, close, high, low, volume by 30-minute block, gap."""
    out = {}
    for s in ["SPY"] + P["universe"]:
        pc = None
        for d in cal:
            bars = day(s, d)
            if len(bars) < 200: pc = bars[-1][4] if bars else pc; continue
            vb = [0] * 13
            for b in bars: vb[b[0] // 30] += b[5]
            out[(s, d)] = dict(o=bars[0][1], c=bars[-1][4], h=max(b[2] for b in bars), l=min(b[3] for b in bars), vb=vb,
                               gap=(bars[0][1] / pc - 1) * 100 if pc else 0, pc=pc)
            pc = bars[-1][4]
    return out


def build():
    random.seed(7)
    cal = calendar(); idx = {d: i for i, d in enumerate(cal)}
    summ = summaries(cal); react = reaction_days(cal, summ)
    pre = {(r[0], r[1]): (r[2], r[3]) for r in db.execute("SELECT symbol, date, vol, last FROM pre")}
    H = his_entries()
    stop = {}
    for x in csv.DictReader(open(f"{B}/t_his_miss.csv")):
        if x["pnl"]: stop[(x["date"], x["sym"], int(x["minute"]))] = float(x["pnl"])
    by_day = collections.defaultdict(list)
    for e in H:
        if e["sym"] in P["universe"]: by_day[e["date"]].append(e)
    import glob
    bot_day = collections.defaultdict(list)  # the bot's flat 1% C entries (tiers_round "flat"), P&L at $10K
    for f in sorted(glob.glob(f"{B}/t_flat_20*_trades.csv")):
        for x in csv.DictReader(open(f)):
            if x["status"] == "ok": bot_day[x["date"]].append(dict(date=x["date"], sym=x["sym"], right=x["right"], minute=int(x["minute"]),
                                                                   his=2, real=round(float(x["pnl"])), trade=""))
    his_days = collections.defaultdict(set); his_pnl_day = collections.Counter()
    for e in H: his_days[e["sym"]].add(e["date"]); his_pnl_day[e["date"]] += e["real"]
    mins = [e["minute"] for e in H if e["sym"] in P["universe"]]
    rows = []
    for i, d in enumerate(cal):
        if d < "2023-01-03" or d > os.environ.get("CTX_END", "9999") or i < 25 or i >= len(cal) - 1: continue
        ser = {}
        def S(x):
            if x not in ser:
                b = day(x, d); ser[x] = series(b)[0] if len(b) > 100 else None
            return ser[x]
        def pcl(x):
            pb = day(x, cal[i - 1]); return pb[-1][4] if pb else None
        if not S("SPY"): continue
        todo = [dict(e, his=1) for e in by_day.get(d, [])] + bot_day.get(d, [])
        for s in P["universe"]:
            if (s, d) in summ: todo.append(dict(date=d, sym=s, minute=random.choice(mins), right=None, his=0, real="", trade=""))
        for e in todo:
            s, m = e["sym"], e["minute"]; sm = summ.get((s, d)); c = S(s)
            if not sm or not c or not c[m] or not sm["pc"]: continue
            pc = sm["pc"]
            if e["right"] is None: e["right"] = "C" if c[m] >= pc else "P"
            bet = 1 if e["right"] == "C" else -1
            mv = lambda x, mm=m: (S(x)[mm] / pcl(x) - 1) * 100 if S(x) and S(x)[mm] and pcl(x) else None
            spy = mv("SPY"); g, etf = SECT[s]
            peers = [mv(p) for p in GROUP[g][0] if p != s and (p, d) in summ]
            peers = [x for x in peers if x is not None]
            up = [S(x)[m] > pcl(x) for x in P["universe"] if (x, d) in summ and S(x) and S(x)[m] and pcl(x)]
            prev = [summ.get((s, cal[k])) for k in range(i - 20, i)]; prev = [p for p in prev if p]
            if len(prev) < 15: continue
            vnow = sum(sm["vb"][:m // 30]) + sm["vb"][m // 30] * ((m % 30) + 1) / 30
            vnorm = st.median(sum(p["vb"][:m // 30]) + p["vb"][m // 30] * ((m % 30) + 1) / 30 for p in prev)
            pv = [pre.get((s, cal[k]), (None,))[0] for k in range(i - 20, i)]; pv = [x for x in pv if x]
            pr = pre.get((s, d))
            rng = [(p["h"] - p["l"]) / p["c"] * 100 for p in prev]; amv = [abs(p["c"] / p["pc"] - 1) * 100 for p in prev if p["pc"]]
            hi20 = max(p["h"] for p in prev[-20:]); lo20 = min(p["l"] for p in prev[-20:])
            r_ = react.get(s, []); j = bisect.bisect_left(r_, i)
            nxt = r_[j] - i if j < len(r_) else 99; last = i - r_[j - 1] if j > 0 else 99
            nx = summ.get((s, cal[i + 1]))
            hd = sorted(his_days[s]); k = bisect.bisect_left(hd, d)
            third_fri = dt.date.fromisoformat(d).weekday() == 4 and 15 <= int(d[8:]) <= 21
            spy_o = summ.get(("SPY", d))
            row = dict(year=d[:4], date=d, sym=s, right=e["right"], minute=m, his=e["his"], trade=e["trade"], real=e["real"],
                       dte=e.get("dte", ""), stop_pnl=stop.get((d, s, m), "") if e["his"] == 1 else "", group=g,
                       move=bet * (c[m] / pc - 1) * 100, gap=bet * sm["gap"],
                       spy=spy, spy_bet=bet * spy if spy is not None else None, spy_day=(spy_o["c"] / spy_o["pc"] - 1) * 100 if spy_o else None,
                       spy_gap=spy_o["gap"] if spy_o else None, qqq=mv("QQQ"), vixy=mv("VIXY"),
                       sector=bet * mv(etf) if mv(etf) is not None else None, peers=bet * st.fmean(peers) if peers else None,
                       breadth=(sum(up) / len(up) if bet > 0 else 1 - sum(up) / len(up)) if up else None,
                       rvol=vnow / vnorm if vnorm else None,
                       pre_rvol=pr[0] / st.median(pv) if pr and len(pv) >= 10 else None,
                       pre_gap=bet * (pr[1] / pc - 1) * 100 if pr else None,
                       prev_day=bet * (prev[-1]["c"] / prev[-1]["pc"] - 1) * 100 if prev[-1]["pc"] else None,
                       ret5=bet * (pc / prev[-5]["pc"] - 1) * 100 if prev[-5]["pc"] else None,
                       ret20=bet * (pc / prev[0]["pc"] - 1) * 100 if prev[0]["pc"] else None,
                       to_20d_ext=(c[m] / hi20 - 1) * 100 if bet > 0 else (lo20 / c[m] - 1) * 100,
                       move_z=abs(c[m] / pc - 1) * 100 / st.fmean(amv) if amv else None, atr=st.fmean(rng),
                       earn_next=nxt, earn_last=last, fomc=int(d in FOMC), cpi=int(d in CPI), opex=int(third_fri),
                       dow=dt.date.fromisoformat(d).weekday(),
                       his_recent=int(k > 0 and idx[d] - idx[hd[k - 1]] <= 5), his_prev_pnl=his_pnl_day.get(cal[i - 1], 0),
                       fwd_close=bet * (sm["c"] / c[m] - 1) * 100, fwd_next_open=bet * (nx["o"] / c[m] - 1) * 100 if nx else None)
            row["vs_sector"] = row["move"] - row["sector"] if row["sector"] is not None else None
            rows.append(row)
        if d[8:] == "01" or i % 60 == 0: print(d, len(rows), flush=True)
    with open(f"{B}/context_rows.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(len(rows), "rows,", sum(r["his"] for r in rows), "his")


def F(r, k):
    v = r[k]
    return None if v in ("", None) else float(v)


def cut(edges, labels):
    def f(r, k):
        v = F(r, k)
        if v is None: return None
        for e, lab in zip(edges, labels):
            if v < e: return lab
        return labels[-1]
    return f


def earn(r, k):
    n, l = int(r["earn_next"]), int(r["earn_last"])
    if n == 0: return "reaction day (first day after the report)"
    if n == 1: return "day before the reaction day"
    if l in (1, 2, 3): return "1-3 days after the reaction day"
    if 2 <= n <= 5: return "2-5 days before"
    return "no report within 5 days"


TESTS = [
    ("Earnings", "earn", earn),
    ("SPY at his minute (vs yesterday's close)", "spy", cut([-0.5, 0.5], ["SPY down >= 0.5%", "SPY within 0.5%", "SPY up >= 0.5%"])),
    ("SPY in his direction at his minute", "spy_bet", cut([-0.5, 0.5], ["against him >= 0.5%", "within 0.5%", "with him >= 0.5%"])),
    ("SPY whole day (hindsight)", "spy_day", cut([-0.5, 0.5], ["down >= 0.5%", "within 0.5%", "up >= 0.5%"])),
    ("SPY gap at the open", "spy_gap", cut([-0.5, 0.5], ["down >= 0.5%", "within 0.5%", "up >= 0.5%"])),
    ("VIXY (fear) at his minute", "vixy", cut([-3, 3], ["down >= 3%", "within 3%", "up >= 3%"])),
    ("Breadth: share of the 40 moving his way", "breadth", cut([0.4, 0.6], ["< 40%", "40-60%", ">= 60%"])),
    ("Pre-market volume vs normal", "pre_rvol", cut([1, 2, 4], ["< 1x", "1-2x", "2-4x", ">= 4x"])),
    ("Pre-market move his way", "pre_gap", cut([-1, 1, 3], ["against >= 1%", "within 1%", "his way 1-3%", "his way >= 3%"])),
    ("Gap at the open his way", "gap", cut([-1, 1, 3], ["against >= 1%", "within 1%", "his way 1-3%", "his way >= 3%"])),
    ("Sector ETF his way at his minute", "sector", cut([-0.5, 0.5, 1.5], ["against >= 0.5%", "within 0.5%", "his way 0.5-1.5%", "his way >= 1.5%"])),
    ("Peers (same group of the 40) his way", "peers", cut([-0.5, 0.5, 1.5], ["against >= 0.5%", "within 0.5%", "his way 0.5-1.5%", "his way >= 1.5%"])),
    ("Stock vs its sector", "vs_sector", cut([0, 2, 5], ["behind its sector", "0-2% ahead", "2-5% ahead", ">= 5% ahead"])),
    ("Stock move his way at his minute", "move", cut([0, 2, 5], ["against him", "0-2%", "2-5%", ">= 5%"])),
    ("Move vs its normal daily move", "move_z", cut([1, 2, 3], ["< 1x", "1-2x", "2-3x", ">= 3x"])),
    ("Day volume so far vs normal", "rvol", cut([1, 1.5, 3], ["< 1x", "1-1.5x", "1.5-3x", ">= 3x"])),
    ("Yesterday's move his way", "prev_day", cut([-2, 2], ["against >= 2%", "within 2%", "his way >= 2%"])),
    ("Last 5 days his way", "ret5", cut([-5, 5], ["against >= 5%", "within 5%", "his way >= 5%"])),
    ("Last 20 days his way", "ret20", cut([-10, 10], ["against >= 10%", "within 10%", "his way >= 10%"])),
    ("Distance to the 20-day high (low for a put)", "to_20d_ext", cut([-5, 0], ["> 5% away", "0-5% away", "beyond it"])),
    ("Normal day range (20-day)", "atr", cut([3, 5, 8], ["< 3%", "3-5%", "5-8%", ">= 8%"])),
    ("FOMC day", "fomc", cut([1], ["no", "yes"])),
    ("CPI day", "cpi", cut([1], ["no", "yes"])),
    ("Monthly options expiry (3rd Friday)", "opex", cut([1], ["no", "yes"])),
    ("Weekday", "dow", lambda r, k: "Mon Tue Wed Thu Fri".split()[int(r[k])]),
    ("Call or put", "right", lambda r, k: r[k]),
    ("Sector group", "group", lambda r, k: r[k]),
    ("He traded this stock in the last 5 days", "his_recent", cut([1], ["no", "yes"])),
    ("His P&L the previous trading day", "his_prev_pnl", cut([-1, 1], ["a loss", "no trades", "a gain"])),
]


def report():
    R = list(csv.DictReader(open(f"{B}/context_rows.csv")))
    his = [r for r in R if r["his"] == "1"]; base = [r for r in R if r["his"] == "0"]; bot = [r for r in R if r["his"] == "2"]
    tot = sum(float(r["real"]) for r in his)
    print(f"{len(his)} entries of his on the 40 stocks (real {tot/1e6:+.2f}M), {len(base)} base stock-days\n")
    for title, k, f in TESTS:
        print(f"### {title}\n\n| | Base | His | Lift | His entries | His real | Per trade | Win | Years 23-26 | Our exit $10K | Bot: trades, 2024 / 2025-26 $10K |\n|---|---|---|---|---|---|---|---|---|---|---|")
        gb = collections.Counter(f(r, k) for r in base); gh = collections.defaultdict(list)
        for r in his: gh[f(r, k)].append(r)
        nb = sum(v for x, v in gb.items() if x is not None); nh = sum(len(v) for x, v in gh.items() if x is not None)
        labs = [x for x in dict.fromkeys(list(gb) + list(gh)) if x is not None]
        for lab in labs:
            g = gh.get(lab, []); p = [float(r["real"]) for r in g]; sp = [float(r["stop_pnl"]) for r in g if r["stop_pnl"]]
            yrs = "".join("+" if sum(float(r["real"]) for r in g if r["year"] == y) > 0 else ("-" if any(r["year"] == y for r in g) else ".") for y in ("2023", "2024", "2025", "2026"))
            gb_ = [r for r in bot if f(r, k) == lab]
            b4 = sum(float(r["real"]) for r in gb_ if r["year"] == "2024"); b56 = sum(float(r["real"]) for r in gb_ if r["year"] > "2024")
            sb, sh = 100 * gb.get(lab, 0) / max(1, nb), 100 * len(g) / max(1, nh)
            print(f"| {lab} | {sb:.0f}% | {sh:.0f}% | {sh/sb if sb else 0:.1f}x | {len(g)} | {sum(p)/1e6:+.2f}M | {st.fmean(p)/1e3 if p else 0:+.1f}K | "
                  f"{100*sum(x>0 for x in p)/len(p) if p else 0:.0f}% | {yrs} | {sum(sp)/1e3:+,.0f}K ({len(sp)}) | "
                  f"{len(gb_)}, {b4/1e3:+,.0f}K / {b56/1e3:+,.0f}K |")
        print()


if __name__ == "__main__":
    build() if sys.argv[1] == "build" else report()
