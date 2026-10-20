"""Why the tier signal missed his entries: for each of his entries on the bot's stocks (2024-2026), did the bot
fire C that stock-day in his direction, and if not, which tier conditions failed at his entry minute.
His P&L per group is his entry run through your stop ($10K, from the t_his round).

  python3 his_miss.py [tag]      (tag = t | tv11 | tv20; from the repo root)
"""
import collections, csv, glob, math, os, statistics as st, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from store import P, day, calendar
from signals import Day, series, E
import report

B = "data/local/x/bt"
TAG = (sys.argv[1:] or ["t"])[0]
V = P["entry_variants"]["tiers"]
if TAG == "tv11": V = dict(V, rvol_day=1.1)
if TAG == "tv20": V = dict(V, rvol_day=2.0)


def conds(d):
    """Per minute from first_minute: (t, rvol_day, rvol_15, at_extreme, past_yesterday) for this Day, or None."""
    cal, i0 = d.cal, d.cal_idx
    vol = [0] * 390
    for b in day(d.sym, d.date): vol[b[0]] = b[5]
    cum, s_ = [0] * 390, 0
    for m in range(390): s_ += vol[m]; cum[m] = s_
    hist = []
    for dd in cal[max(0, i0 - 20):i0]:
        v = [0] * 390
        for b in day(d.sym, dd): v[b[0]] = b[5]
        c_, t_ = [0] * 390, 0
        for m in range(390): t_ += v[m]; c_[m] = t_
        if c_[-1] > 0: hist.append(c_)
    if len(hist) < 10 or d.beta is None: return None
    spy = series(day("SPY", d.date))[0]
    c, k_ = d.c, V["step"]
    pb = day(d.sym, cal[i0 - 1]); phi, plo = max(x[2] for x in pb), min(x[3] for x in pb)
    steps, out = [], {}
    for m in range(k_, 390):
        if m % k_ == 0 and c[m] and c[m - k_] and spy[m] and spy[m - k_]:
            steps.append(d.bet * ((c[m] / c[m - k_] - 1) - d.beta * (spy[m] / spy[m - k_] - 1)))
        if len(steps) < V["min_steps"] or c[m] is None: continue
        sd = st.pstdev(steps)
        t = st.fmean(steps) / sd * math.sqrt(len(steps)) if sd else 0
        mc = st.median(h[m] for h in hist); m15 = st.median(h[m] - (h[m - 15] if m >= 15 else 0) for h in hist)
        out[m] = (t, cum[m] / mc if mc else 0, (cum[m] - (cum[m - 15] if m >= 15 else 0)) / m15 if m15 else 0,
                  (d.range_pos[m] or 0) >= V["range_pos"], c[m] > phi if d.bet > 0 else c[m] < plo)
    return out


def main():
    cal = calendar(); idx = {d: i for i, d in enumerate(cal)}
    rows = []
    for y in ("2024", "2025", "2026"):
        bot = {(r["date"], r["sym"]): r for r in csv.DictReader(open(f"{B}/{TAG}_sig_tiers_{y}.csv"))}
        traded = {}
        for f in glob.glob(f"{B}/{TAG}_flat_{y}.[0-9]_trades.csv"):
            for t in csv.DictReader(open(f)): traded[(t["date"], t["sym"])] = t["status"]
        T, S, _ = report.load(f"{B}/t_his_{y}")
        pnl = {(t["date"], t["sym"], t["minute"]): 1e4 * report.ret_at(S[t["_i"]], report.SH) for t in T if t["status"] == "ok"}
        for h in csv.DictReader(open(f"{B}/t_sig_his_{y}.csv")):
            m, bet = int(h["minute"]), 1 if h["right"] == "C" else -1
            r = dict(year=y, date=h["date"], sym=h["sym"], right=h["right"], minute=m, pnl=pnl.get((h["date"], h["sym"], h["minute"])))
            b = bot.get((h["date"], h["sym"]))
            if b and b["right"] == h["right"]:
                bm = int(b["minute"]); r["group"] = "caught"
                r["timing"] = "bot earlier" if bm < m - 15 else "bot later" if bm > m + 15 else "within 15 min"
                r["bot_status"] = traded.get((h["date"], h["sym"]), "?")
            elif b:
                r["group"] = "bot fired the other way"
            else:
                d = Day(h["sym"], h["date"], bet, cal, idx.get(h["date"], 0))
                cd = conds(d) if d.ok else None
                if cd is None: r["group"] = "no data (beta / volume history)"
                elif m < V["first_minute"]: r["group"] = "before 9:40"
                elif m > E["last_minute"]: r["group"] = "after 15:44"
                else:
                    x = cd.get(m) or cd.get(m - 1)
                    if not x: r["group"] = "no bar"
                    else:
                        t, rv, r15, ext, prev = x
                        f1, f2 = t < V["strength_t"], rv < V["rvol_day"]
                        r["group"] = "both weak" if f1 and f2 else "not steady vs SPY (1)" if f1 else "volume too low (2)"
                        r.update(t=round(t, 2), rvol=round(rv, 2), r15=round(r15, 2), ext=int(ext), prev=int(prev))
                        later = [mm for mm, v in cd.items() if mm > m and mm <= E["last_minute"] and v[0] >= V["strength_t"] and v[1] >= V["rvol_day"]]
                        r["c_later"] = later[0] if later else ""
            rows.append(r)
    with open(f"{B}/{TAG}_his_miss.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(dict.fromkeys(k for r in rows for k in r))); w.writeheader(); w.writerows(rows)
    g = collections.defaultdict(list)
    for r in rows: g[r["group"]].append(r)
    n = len(rows)
    print(f"{n} of his entries on the 40 stocks, 2024-2026 (tag {TAG})\n")
    print("| Group | Entries | Share | His P&L, your stop | Per trade |\n|---|---|---|---|---|")
    for k, v in sorted(g.items(), key=lambda kv: -len(kv[1])):
        p = [r["pnl"] for r in v if r["pnl"] is not None]
        print(f"| {k} | {len(v)} | {100*len(v)/n:.0f}% | {sum(p)/1e3:+,.0f}K | {st.fmean(p) if p else 0:+,.0f} |")
    c = g["caught"]
    print("\ncaught timing:", collections.Counter(r["timing"] for r in c), "| bot status:", collections.Counter(r["bot_status"] for r in c))
    miss = [r for k in ("not steady vs SPY (1)", "volume too low (2)", "both weak") for r in g[k]]
    if miss:
        print("missed at his minute (median): t", st.median(r["t"] for r in miss), "| rvol", st.median(r["rvol"] for r in miss),
              "| at extreme", f"{100*st.fmean(r['ext'] for r in miss):.0f}%", "| past yesterday", f"{100*st.fmean(r['prev'] for r in miss):.0f}%",
              "| C true later that day", f"{100*st.fmean(r['c_later'] != '' for r in miss):.0f}%")
        for lo, hi in ((0, 1.1), (1.1, 1.5), (1.5, 2), (2, 99)):
            s = [r for r in miss if lo <= r["rvol"] < hi]
            print(f"   rvol {lo}-{hi}: {len(s)}")
        for lo, hi in ((-99, 0), (0, 1), (1, 2), (2, 99)):
            s = [r for r in miss if lo <= r["t"] < hi]
            print(f"   t {lo}-{hi}: {len(s)}")
    print("his entry times:", collections.Counter(("before 9:40" if r["minute"] < 10 else "9:40-10:30" if r["minute"] < 60 else "10:30-12:00" if r["minute"] < 150 else "12:00-15:44" if r["minute"] <= 374 else "after 15:44") for r in rows))


if __name__ == "__main__":
    main()
