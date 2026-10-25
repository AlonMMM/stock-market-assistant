"""V2: the alert strangle, wider (the user, 2026-10-25). On the first volume alert of an expiry day (either direction,
09:40-13:00 New York), buy the call and the put of the same-day expiry at one delta; when the side is confirmed, sell the
wrong leg and ride the right one; no confirmation within the wait -> both legs out. Fair list, news filter, both legs
with 200+ contracts in the last 30 minutes.

Grid: delta 0.30 / 0.35 / 0.40 x confirmation (the stock 0.15 / 0.25 / 0.35 / 0.5 of its typical 30-minute move from the
entry close, or the leading leg +30%) x wait 30 / 60 / 90 min x kept-leg exit (trail 20 / 30 / 45 / 60% off its high to
15:30, the 60 / 90-minute clock, hold to 15:30) x fill at the mid +/- 2% (the study's model) or 5% (harsh, two legs).

  node --env-file=.env <path>/run.mjs zero6.py run       -> data/local/x/bt/z6_results.json, z6_report.json (for the page)
  python3 <path>/zero6.py report                          -> z6_report.json again from the saved results
"""
import collections, datetime as dt, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar
from levels import ctx
from rvol_alert import alerts_for
import zero5

B = "data/local/x/bt"
OUT, REPORT = f"{B}/z6_results.json", f"{B}/z6_report.json"
SPAN = zero5.SPAN
DELTAS = (0.30, 0.35, 0.40)
CONFIRMS = {"stk15": ("stock", 0.15), "stk25": ("stock", 0.25), "stk35": ("stock", 0.35), "stk50": ("stock", 0.5), "leg30": ("leg", 0.30)}
WAITS = (30, 60, 90)
KEEPS = ("trail20", "trail30", "trail45", "trail60", "t60", "t90", "close")
FILLS = (0.02, 0.05)
HEAD = [("0.35", "stk25", 60, "trail30", 0.02), ("0.35", "stk25", 60, "trail45", 0.02)]   # per-trade detail kept for these
CAL = calendar()


def one(sig):
    date, sym, m = sig
    sb = {b[0]: b for b in day(sym, date)}
    if m not in sb: return sig, None
    px = sb[m][4]
    x = ctx(sym, date)
    if not x or not x.get("sd"): return sig, None
    out = {}
    for d in DELTAS:
        sim.C.update(dte_min=0, dte_max=0, delta=d)
        legs = {}
        for right in ("C", "P"):
            best, why = sim.pick(sym, date, m, right, px)
            if best is None: legs = None; out[str(d)] = f"{right}:{why}"; break
            legs[right] = best[0]
        if not legs: continue
        bars = {r: {b[0]: b for b in day(legs[r], date)} for r in legs}
        # the common path: closes of both legs per minute from the fill
        last, fill_t, path = {}, None, []
        for t in range(m + 1, 361):
            for r in legs:
                if t in bars[r]: last[r] = bars[r][t]
            if len(last) < 2: continue
            if fill_t is None:
                if t > m + 3: break
                fill_t = t; fill_mid = {r: sim.mid(last[r]) for r in legs}; continue
            path.append((t, {r: last[r][4] for r in legs}, {r: sim.mid(last[r]) for r in legs}, sb[t][4] if t in sb else None))
        if fill_t is None or not path: out[str(d)] = "no_fill"; continue
        stock0 = sb[fill_t][4] if fill_t in sb else px
        res = {}
        for sh in FILLS:
            paid = {r: fill_mid[r] * (1 + sh) for r in legs}; cost = sum(paid.values())
            comm = sim.COMM * 4 / (cost * 100)
            sell = lambda mids, rs: max(sum(mids[r] for r in rs) * (1 - sh), 0.01)
            for cn, (kind, k) in CONFIRMS.items():
                for w in WAITS:
                    conf = None
                    for t, closes, mids, spot in path:
                        if t - m > w: break
                        if kind == "stock" and spot is not None:
                            mv = spot / stock0 - 1
                            if abs(mv) >= k * x["sd"]: conf = (t, "C" if mv > 0 else "P"); break
                        if kind == "leg":
                            g = {r: closes[r] / paid[r] - 1 for r in legs}; lead = max(g, key=g.get)
                            if g[lead] >= k and g[lead] > min(g.values()): conf = (t, lead); break
                    if conf is None:
                        # both out at the wait (or the last path minute before it)
                        row = next((p for p in path if p[0] - m >= w), path[-1])
                        r0 = round(sell(row[2], legs) / cost - 1 - comm, 4)
                        for kp in KEEPS: res[f"{sh}|{cn}|{w}|{kp}"] = r0
                        if (str(d), cn, w, "trail30", sh) in HEAD or (str(d), cn, w, "trail45", sh) in HEAD:
                            res[f"detail|{sh}|{cn}|{w}"] = dict(confirmed=False, exit_minute=row[0])
                        continue
                    ct, keep = conf; wrong = "P" if keep == "C" else "C"
                    crow = next(p for p in path if p[0] == ct)
                    sold_wrong = max(crow[2][wrong] * (1 - sh), 0.01)
                    for kp in KEEPS:
                        peak = crow[1][keep]; ret = None; exit_t = None
                        for t, closes, mids, spot in path:
                            if t <= ct: continue
                            c = closes[keep]; peak = max(peak, c)
                            done = t >= 360
                            if kp.startswith("trail"): done = done or c <= peak * (1 - int(kp[5:]) / 100)
                            elif kp == "t60": done = done or t - m >= 60
                            elif kp == "t90": done = done or t - m >= 90
                            if done:
                                ret = round((sold_wrong + max(mids[keep] * (1 - sh), 0.01)) / cost - 1 - comm, 4); exit_t = t; break
                        if ret is None:  # path ended (the last bar before 15:30): out at the last mid
                            t, closes, mids, spot = path[-1]
                            ret = round((sold_wrong + max(mids[keep] * (1 - sh), 0.01)) / cost - 1 - comm, 4); exit_t = t
                        res[f"{sh}|{cn}|{w}|{kp}"] = ret
                        if (str(d), cn, w, kp, sh) in HEAD:
                            res[f"detail|{sh}|{cn}|{w}|{kp}"] = dict(confirmed=True, side=keep, confirm_minute=ct, exit_minute=exit_t,
                                                                    wrong_recovered=round(sold_wrong / paid[wrong], 3), kept_ret=round(max(mids[keep] * (1 - sh), 0.01) / paid[keep] - 1, 3) if exit_t else None,
                                                                    legs=legs)
        out[str(d)] = res
    return sig, out


def run():
    ent = zero5.entries()
    print(len(ent), "first-alerts", flush=True)
    done = {}
    with mp.Pool(8) as pool:
        for i, (sig, res) in enumerate(pool.imap_unordered(one, [e[:3] for e in ent], chunksize=4)):
            done["|".join(map(str, sig))] = dict(side=next(e[3] for e in ent if e[:3] == sig), res=res)
            if i % 200 == 0: print(i, "/", len(ent), flush=True)
    json.dump(done, open(OUT, "w")); print("walks done", flush=True)
    report()


def account_curve(T, pct):
    """T: [(date, minute, ret)] sorted. -> (end, worst drop, [(date, equity)] one point per trade)."""
    eq, cur, start, peak, dd, curve = 1e5, None, 1e5, 1e5, 0.0, []
    for d, m, r in T:
        if d != cur: cur = d; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        eq += pct * start * max(-1, r); curve.append((d, round(eq)))
    peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
    return eq, dd, curve


def metrics(T):
    T = sorted(T, key=lambda x: (x[0], x[1]))
    if not T: return None
    rets = [r for d, m, r in T]
    yr = {y: [1e4 * max(-1, r) for d, m, r in T if d[:4] == y] for y in SPAN}
    best5 = set(sorted(range(len(T)), key=lambda i: -T[i][2])[:5])
    out = dict(n=len(T), win=round(100 * sum(r > 0 for r in rets) / len(rets)), per_year={y: round(st.fmean(v)) if v else None for y, v in yr.items()},
               median=round(1e4 * st.median(rets)), over50=round(100 * sum(r > 0.5 for r in rets) / len(rets)), under30=round(100 * sum(r < -0.3 for r in rets) / len(rets)))
    for pct in (0.01, 0.02, 0.03):
        e, dd, _ = account_curve(T, pct); out[f"end{int(pct * 100)}"] = round(e); out[f"dd{int(pct * 100)}"] = round(100 * dd)
    e5, _, _ = account_curve([x for i, x in enumerate(T) if i not in best5], 0.01); out["wo5"] = round(e5)
    out["every_year_positive"] = all((v or 0) > 0 for v in out["per_year"].values())
    return out


def report():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    done = json.load(open(OUT))
    rows = []
    for k, v in done.items():
        date, sym, m = k.split("|")
        rows.append(dict(date=date, sym=sym, minute=int(m), right="C", side=v["side"], res=v["res"] or {}))
    nf.features(rows)
    fair = [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
    rep = dict(generated=dt.date.today().isoformat(), first_alerts=len(rows), fair_first_alerts=len(fair), deltas={}, headline={}, span=SPAN)
    for d in DELTAS:
        ok = [t for t in fair if isinstance(t["res"].get(str(d)), dict)]
        reasons = collections.Counter(t["res"].get(str(d)) for t in fair if isinstance(t["res"].get(str(d)), str))
        grid = {}
        for sh in FILLS:
            for cn in CONFIRMS:
                for w in WAITS:
                    for kp in KEEPS:
                        key = f"{sh}|{cn}|{w}|{kp}"
                        T = [(t["date"], t["minute"], t["res"][str(d)][key]) for t in ok if isinstance(t["res"][str(d)].get(key), float)]
                        mt = metrics(T)
                        if mt: grid[key] = mt
        rep["deltas"][str(d)] = dict(tradeable=len(ok), skipped=dict(reasons.most_common()), grid=grid)
    # headline detail: delta 0.35, stk25, wait 60, trail 30 and 45, fill 2%
    for kp in ("trail30", "trail45"):
        d, cn, w, sh = "0.35", "stk25", 60, 0.02
        ok = [t for t in fair if isinstance(t["res"].get(d), dict) and isinstance(t["res"][d].get(f"{sh}|{cn}|{w}|{kp}"), float)]
        T = sorted(((t["date"], t["minute"], t["res"][d][f"{sh}|{cn}|{w}|{kp}"]) for t in ok), key=lambda x: (x[0], x[1]))
        curves = {pct: account_curve(T, pct / 100)[2] for pct in (1, 2, 3)}
        trades = []
        for t in ok:
            r = t["res"][d]; det = r.get(f"detail|{sh}|{cn}|{w}|{kp}") or r.get(f"detail|{sh}|{cn}|{w}") or {}
            trades.append(dict(date=t["date"], sym=t["sym"], minute=t["minute"], time=f"{(570 + t['minute']) // 60:02d}:{(570 + t['minute']) % 60:02d}", alert=t["side"],
                               ret=r[f"{sh}|{cn}|{w}|{kp}"], weekday=dt.date.fromisoformat(t["date"]).strftime("%a"), **{k_: v_ for k_, v_ in det.items() if k_ != "legs"},
                               call=(det.get("legs") or {}).get("C"), put=(det.get("legs") or {}).get("P")))
        by = lambda f: {k_: metrics([(x["date"], x["minute"], x["ret"]) for x in trades if f(x) == k_]) for k_ in sorted({f(x) for x in trades}, key=str)}
        hour = lambda x: "09:40-10:30" if x["minute"] <= 60 else "10:30-12:00" if x["minute"] <= 150 else "12:00-13:00"
        rep["headline"][kp] = dict(rule=dict(delta=d, confirm=cn, wait=w, keep=kp, fill=sh), metrics=metrics(T), curves=curves, trades=trades,
                                   by_weekday=by(lambda x: x["weekday"]), by_hour=by(hour), by_side=by(lambda x: x["alert"]), by_year=by(lambda x: x["date"][:4]),
                                   by_stock={s_: m_ for s_, m_ in by(lambda x: x["sym"]).items() if m_ and m_["n"] >= 3},
                                   confirmed=sum(1 for x in trades if x.get("confirmed")), median_confirm_min=st.median([x["confirm_minute"] - x["minute"] for x in trades if x.get("confirmed")]) if any(x.get("confirmed") for x in trades) else None)
    json.dump(rep, open(REPORT, "w")); print("report written", REPORT, flush=True)
    g = rep["deltas"]["0.35"]["grid"]
    for key in ("0.02|stk25|60|trail30", "0.02|stk25|60|trail45", "0.05|stk25|60|trail30", "0.05|stk25|60|trail45"):
        print(key, g.get(key))


if __name__ == "__main__":
    {"run": run, "report": report}[sys.argv[1]]()
