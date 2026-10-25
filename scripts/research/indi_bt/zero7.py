"""V2: the alert strangle with market filters and the D bonus (the user, 2026-10-25). Delta 0.35, confirm 0.25 S30,
wait 60, kept leg trail 30% (and the 60-minute clock); fills mid +/- 2 / 3 / 4 / 5% a leg; sizing 1-4% a trade.

Per first-alert entry (expiry day, 09:40-13:00, fair list, news filter, both legs 200+ contracts), context at the alert:
  spy_ratio   SPY's |3-minute move| at the alert minute / the median of the same minutes over the prior 20 sessions
  breadth     how many of the 40 stocks have an alert within +/- 2 minutes of this one (the market moving, not the stock)
  t_agree     the stock's strength vs SPY x beta since the open (the C t-stat) has the sign of the kept leg
Variants:
  base        as zero6: raw stock move confirms the side
  excess      the side is confirmed on the stock's move minus beta x SPY's move since the fill (0.25 S30)
  d_recycle   at confirmation, the wrong leg's proceeds buy more of the kept leg (same exit)
  d_double    at confirmation, one more unit of the kept leg is bought (the premium grows; return on all of it)
Filters (in the report, on the base and the variants): breadth < 3 / < 5, spy_ratio < 2 / < 3, t_agree.

  node --env-file=.env <path>/run.mjs zero7.py run   -> data/local/x/bt/z7_results.json, z7_report.json
  python3 <path>/zero7.py report
"""
import collections, datetime as dt, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar
from signals import series, beta
from levels import ctx
from rvol_alert import alerts_for, windows, med
import zero5, zero6

B = "data/local/x/bt"
OUT, REPORT = f"{B}/z7_results.json", f"{B}/z7_report.json"
SPAN = zero5.SPAN
DELTA, CONFIRM_K, WAIT = 0.35, 0.25, 60
FILLS = (0.02, 0.03, 0.04, 0.05)
KEEPS = ("trail30", "t60")
VARIANTS = ("base", "excess", "d_recycle", "d_double")
CAL = calendar()
_spyw = {}


def spy_ratio(date, m):
    """SPY's 3-minute |move| at m / the median of the same window over the prior 20 sessions."""
    i = CAL.index(date)
    w = windows(day("SPY", date))[0]
    if w[m] is None: return None
    hist = []
    for d in CAL[i - 20:i]:
        if d not in _spyw: _spyw[d] = windows(day("SPY", d))[0]
        if _spyw[d][m] is not None: hist.append(_spyw[d][m][1])
    if len(hist) < 10: return None
    u = med(hist)
    return round(w[m][1] / u, 2) if u else None


def tstat(sym, date, m, b_):
    c = series(day(sym, date))[0]; s = series(day("SPY", date))[0]
    xs = []
    for k in range(1, m + 1):
        if c[k] and c[k - 1] and s[k] and s[k - 1]: xs.append((c[k] / c[k - 1] - 1) - b_ * (s[k] / s[k - 1] - 1))
    if len(xs) < 10: return None
    mu = st.fmean(xs); sd = st.pstdev(xs)
    return round(mu / sd * math.sqrt(len(xs)), 2) if sd else 0.0


def one(sig):
    date, sym, m = sig
    sb = {b[0]: b for b in day(sym, date)}; ss = {b[0]: b for b in day("SPY", date)}
    if m not in sb: return sig, None
    px = sb[m][4]
    x = ctx(sym, date)
    if not x or not x.get("sd"): return sig, None
    i = CAL.index(date); b_ = beta(sym, date, i, CAL)
    sim.C.update(dte_min=0, dte_max=0, delta=DELTA)
    legs = {}
    for right in ("C", "P"):
        best, why = sim.pick(sym, date, m, right, px)
        if best is None: return sig, {"skip": f"{right}:{why}"}
        legs[right] = best[0]
    bars = {r: {b[0]: b for b in day(legs[r], date)} for r in legs}
    last, fill_t, path = {}, None, []
    for t in range(m + 1, 361):
        for r in legs:
            if t in bars[r]: last[r] = bars[r][t]
        if len(last) < 2: continue
        if fill_t is None:
            if t > m + 3: break
            fill_t = t; fill_mid = {r: sim.mid(last[r]) for r in legs}; continue
        path.append((t, {r: last[r][4] for r in legs}, {r: sim.mid(last[r]) for r in legs}, sb[t][4] if t in sb else None, ss[t][4] if t in ss else None))
    if fill_t is None or not path: return sig, {"skip": "no_fill"}
    stock0 = sb[fill_t][4] if fill_t in sb else px; spy0 = ss[fill_t][4] if fill_t in ss else None
    out = dict(context=dict(spy_ratio=spy_ratio(date, m), t=tstat(sym, date, m, b_) if b_ is not None else None, beta=round(b_, 2) if b_ is not None else None), res={})
    for sh in FILLS:
        paid = {r: fill_mid[r] * (1 + sh) for r in legs}; cost0 = sum(paid.values())
        sell1 = lambda mid_: max(mid_ * (1 - sh), 0.01)
        for var in VARIANTS:
            # confirmation
            conf = None
            for t, closes, mids, spot, spy in path:
                if t - m > WAIT: break
                if spot is None: continue
                mv = spot / stock0 - 1
                if var == "excess" and spy is not None and spy0 and b_ is not None: mv = mv - b_ * (spy / spy0 - 1)
                if abs(mv) >= CONFIRM_K * x["sd"]: conf = (t, "C" if mv > 0 else "P"); break
            if conf is None:
                row = next((p for p in path if p[0] - m >= WAIT), path[-1])
                r0 = round(sum(sell1(row[2][r]) for r in legs) / cost0 - 1 - sim.COMM * 4 / (cost0 * 100), 4)
                for kp in KEEPS: out["res"][f"{sh}|{var}|{kp}"] = r0
                out["res"][f"conf|{sh}|{var}"] = None
                continue
            ct, keep = conf; wrong = "P" if keep == "C" else "C"
            crow = next(p for p in path if p[0] == ct)
            sold_wrong = sell1(crow[2][wrong])
            units, cost = 1.0, cost0           # units of the kept leg held, total premium paid
            if var == "d_recycle": add_px = crow[2][keep] * (1 + sh); units += sold_wrong / add_px; sold_wrong = 0.0   # the proceeds are reinvested, not new premium
            if var == "d_double": add_px = crow[2][keep] * (1 + sh); units += 1.0; cost += add_px
            out["res"][f"conf|{sh}|{var}"] = dict(minute=ct, side=keep)
            for kp in KEEPS:
                peak = crow[1][keep]; ret = None
                for t, closes, mids, spot, spy in path:
                    if t <= ct: continue
                    c = closes[keep]; peak = max(peak, c)
                    done = t >= 360 or (kp == "trail30" and c <= peak * 0.7) or (kp == "t60" and t - m >= 60)
                    if done: ret = round((sold_wrong + units * sell1(mids[keep])) / cost - 1 - sim.COMM * (4 + (2 if var.startswith("d_") else 0)) / (cost * 100), 4); break
                if ret is None:
                    t, closes, mids, spot, spy = path[-1]
                    ret = round((sold_wrong + units * sell1(mids[keep])) / cost - 1 - sim.COMM * (4 + (2 if var.startswith("d_") else 0)) / (cost * 100), 4)
                out["res"][f"{sh}|{var}|{kp}"] = ret
    return sig, out


def run():
    ent = zero5.entries()
    print(len(ent), "first-alerts", flush=True)
    # breadth: every alert minute of every stock in the universe, by date
    allal = collections.defaultdict(list)
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            if not sim.expiry_for(sym, date) == date: continue
            al = alerts_for(sym, date, CAL)
            if al:
                for q, a in enumerate(al):
                    if a: allal[date].append((sym, q))
    done = {}
    with mp.Pool(8) as pool:
        for i, (sig, res) in enumerate(pool.imap_unordered(one, [e[:3] for e in ent], chunksize=4)):
            date, sym, m = sig
            breadth = len({s for s, q in allal[date] if s != sym and abs(q - m) <= 2})
            done["|".join(map(str, sig))] = dict(side=next(e[3] for e in ent if e[:3] == sig), breadth=breadth, out=res)
            if i % 200 == 0: print(i, "/", len(ent), flush=True)
    json.dump(done, open(OUT, "w")); print("walks done", flush=True)
    report()


def report():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    done = json.load(open(OUT))
    rows = []
    for k, v in done.items():
        date, sym, m = k.split("|")
        rows.append(dict(date=date, sym=sym, minute=int(m), right="C", side=v["side"], breadth=v["breadth"], out=v["out"]))
    nf.features(rows)
    fair = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
    ok = [t for t in fair if t["out"] and "res" in t["out"]]
    def agree(t, sh, var):
        c = t["out"]["res"].get(f"conf|{sh}|{var}"); tt = t["out"]["context"].get("t")
        return bool(c) and tt is not None and ((tt > 0) == (c["side"] == "C"))
    FILTERS = {"all": lambda t, sh, var: True,
               "breadth < 3": lambda t, sh, var: t["breadth"] < 3, "breadth < 5": lambda t, sh, var: t["breadth"] < 5,
               "SPY calm (ratio < 2)": lambda t, sh, var: (t["out"]["context"]["spy_ratio"] or 0) < 2, "SPY calm (ratio < 3)": lambda t, sh, var: (t["out"]["context"]["spy_ratio"] or 0) < 3,
               "strength agrees with the kept leg": agree,
               "breadth < 3 and strength agrees": lambda t, sh, var: t["breadth"] < 3 and agree(t, sh, var)}
    rep = dict(generated=dt.date.today().isoformat(), n_fair=len(fair), n_ok=len(ok), rows=[])
    for sh in FILLS:
        for var in VARIANTS:
            for kp in KEEPS:
                key = f"{sh}|{var}|{kp}"
                for fname, ff in FILTERS.items():
                    T = [(t["date"], t["minute"], t["out"]["res"][key]) for t in ok if isinstance(t["out"]["res"].get(key), float) and ff(t, sh, var)]
                    mt = zero6.metrics(T)
                    if not mt: continue
                    e4, dd4, _ = zero6.account_curve(sorted(T, key=lambda x: (x[0], x[1])), 0.04); mt["end4"] = round(e4); mt["dd4"] = round(100 * dd4)
                    rep["rows"].append(dict(fill=sh, variant=var, keep=kp, filter=fname, **mt))
    # context distributions
    rep["breadth_hist"] = dict(collections.Counter(min(t["breadth"], 8) for t in ok))
    rep["spy_ratio_bands"] = dict(collections.Counter("<1" if (t["out"]["context"]["spy_ratio"] or 0) < 1 else "1-2" if t["out"]["context"]["spy_ratio"] < 2 else "2-3" if t["out"]["context"]["spy_ratio"] < 3 else "3+" for t in ok))
    json.dump(rep, open(REPORT, "w"))
    print(f"\n{len(ok)} tradeable of {len(fair)} fair first-alerts; breadth {rep['breadth_hist']}; SPY ratio bands {rep['spy_ratio_bands']}\n")
    print("| fill | variant | keep | filter | n | win | 2024 / 2025 / 2026 | wo5 | 1% | 2% | 3% | 4% |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rep["rows"]:
        if r["fill"] not in (0.02, 0.04) or r["keep"] != "trail30": continue
        if r["variant"] not in ("base", "excess", "d_recycle", "d_double"): continue
        if r["filter"] not in ("all", "breadth < 3", "SPY calm (ratio < 2)", "strength agrees with the kept leg", "breadth < 3 and strength agrees"): continue
        if r["variant"] != "base" and r["filter"] != "all": continue
        py = r["per_year"]
        print(f"| {r['fill']} | {r['variant']} | {r['keep']} | {r['filter']} | {r['n']} | {r['win']}% | {py['2024']:+,} / {py['2025']:+,} / {py['2026']:+,} | ${r['wo5']:,} | ${r['end1']:,} / {r['dd1']}% | ${r['end2']:,} / {r['dd2']}% | ${r['end3']:,} / {r['dd3']}% | ${r['end4']:,} / {r['dd4']}% |")


if __name__ == "__main__":
    {"run": run, "report": report}[sys.argv[1]]()
