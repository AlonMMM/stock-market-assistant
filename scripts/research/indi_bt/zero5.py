"""V2: 0DTE with the site's volume alert (the user, 2026-10-25), on zero4's breakout signals and walks. Fair list only
(the user dropped the unseen test on 2026-10-25); the guards are every year positive and the result without the best 5.

Four tests:
  1. alert-silence exit    no alert on the stock within 30 (15) minutes of the entry -> out (sim.py alert_silence)
  2. alert-confirmed entry the breakout counts only if a same-side alert fired within the last 5 (15) minutes
  3. alert straddle        on the first alert of the day (either side, 09:40-13:00), buy the nearest OTM call and put,
                           same-day expiry; out after 30 / 60 minutes, or at +50% / +100% of the pair, or -50%; by 15:30
  4. alert as a bonus      the confirmation's day-volume ratio counts 1.5x for 15 minutes after a same-side alert
                           (c1b / c2b next to zero4's c1 / c2): the signal is reached sooner
Zero4's entries (breakout kinds, confirmations c1 / c2), deltas 0.15 / 0.25, exits S / T100 / THIRDS; the champion's stop
first; news filter; 1% of the start-of-day account from $100,000.

  node --env-file=.env <path>/run.mjs zero5.py run      (from the repo root) -> data/local/x/bt/z5_results.json, z5_straddles.json
  python3 <path>/zero5.py summary
"""
import collections, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar
from signals import series, beta
from tiers_round import H
from levels import ctx, BREAK
from rvol_alert import alerts_for

B = "data/local/x/bt"
OUT, OUT_S, Z4 = f"{B}/z5_results.json", f"{B}/z5_straddles.json", f"{B}/z4_results.json"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
FIRST, LAST = 10, 209
KINDS = ("prev", "five", "or15", "day", "any")
CONFIRM = {"c1": (1.0, 1.2, False), "c2": (1.5, 1.5, False), "c1b": (1.0, 1.2, True), "c2b": (1.5, 1.5, True)}
BONUS, BONUS_MIN = 1.5, 15
DELTAS = (0.15, 0.25)
X0 = {**sim.X, **H}
BASE = {"S": {}, "T100": dict(takes=[[1.0, 1.0]]), "THIRDS": dict(takes=[[0.5, 1 / 3], [1.0, 1 / 3]], trail=0.3)}
EXITS = dict(BASE)
for n_ in (30,):
    for k_, v_ in BASE.items(): EXITS[f"{k_}_as{n_}"] = dict(v_, alert_silence={"min": n_})
EXITS["S_as15"] = dict(alert_silence={"min": 15})
sim.C.update(dte_min=0, dte_max=0)
CAL = calendar()
IDX = {d: i for i, d in enumerate(CAL)}
STRADDLE = {"t30": (30, None, None), "t60": (60, None, None), "t90": (90, None, None), "t120": (120, None, None), "tclose": (999, None, None),
            "k50_t60": (60, 0.5, None), "k100_t60": (60, 1.0, None), "s50_t60": (60, None, -0.5), "k100_t120": (120, 1.0, None)}


def stock(sym):
    """-> ([(date, sym, m, right, rule)], {(date, sym, m, right): tags}) for one stock. zero4's loop with the bonus and tags."""
    out, tags = [], {}
    for i, date in enumerate(CAL):
        if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
        if not sim.expiry_for(sym, date) == date: continue
        x = ctx(sym, date)
        if x is None: continue
        b_ = beta(sym, date, i, CAL)
        if b_ is None: continue
        hist = []
        for d in CAL[i - 20:i]:
            v = [0] * 390
            for bar in day(sym, d): v[bar[0]] = bar[5]
            acc, cum = 0, []
            for q in v: acc += q; cum.append(acc)
            if cum[-1] > 0: hist.append(cum)
        if len(hist) < 10: continue
        al = alerts_for(sym, date, CAL) or [None] * 390
        c = x["c"]; spy = series(day("SPY", date))[0]
        vol = [0] * 390
        for bar in day(sym, date): vol[bar[0]] = bar[5]
        cum, acc = [], 0
        for q in vol: acc += q; cum.append(acc)
        n = s1 = s2 = 0.0
        found = {}
        for m in range(1, LAST + 1):
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                r = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
                n += 1; s1 += r; s2 += r * r
            if m < FIRST or c[m] is None or n < 10: continue
            prev_c = next((c[j] for j in range(m - 1, -1, -1) if c[j]), None)
            if prev_c is None: continue
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
            med = sorted(hh[m] for hh in hist); k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            rv = cum[m] / usual if usual else 0.0
            hs = [v for v in x["h"][:m] if v]; ls = [v for v in x["l"][:m] if v]
            lv = {"prev": (x["prev_hi"], x["prev_lo"]), "five": (x["p5_hi"], x["p5_lo"])}
            if m >= 15 and any(x["h"][:15]):
                lv["or15"] = (max(v for v in x["h"][:15] if v), min(v for v in x["l"][:15] if v))
                if hs: lv["day"] = (max(hs), min(ls))
            margin = BREAK * x["sd"] * c[m]
            for kind, (hi, lo) in lv.items():
                for right, bet, level in (("C", 1, hi), ("P", -1, lo)):
                    now = bet * (c[m] - level) >= margin
                    before = bet * (prev_c - level) >= margin
                    if not now or before: continue
                    tt = bet * t
                    want = "up" if bet > 0 else "down"
                    recent = lambda w: any(al[q] == want for q in range(max(0, m - w + 1), m + 1))
                    rvb = rv * BONUS if recent(BONUS_MIN) else rv
                    for cname, (need_t, need_v, bonus) in CONFIRM.items():
                        if tt < need_t or (rvb if bonus else rv) < need_v: continue
                        for kk in (kind, "any"):
                            rule = f"{kk}|{cname}"
                            if rule not in found: found[rule] = (m, right)
                    tags[(date, sym, m, right)] = dict(a5=recent(5), a15=recent(15))
        for rule, (m, right) in found.items():
            out.append((date, sym, m, right, rule))
    return out, tags


def walk(job):
    """One signal: the (delta|exit) keys not yet known. -> (sig, {key: ret or reason})"""
    sig, need = job
    date, sym, m, right = sig
    res = {}
    spot = day(sym, date)
    px = next((b[4] for b in spot if b[0] == m), None)
    if px is None: return sig, {k: "no_spot" for k in need}
    for d in DELTAS:
        keys = [k for k in need if k.startswith(f"{d}|")]
        if not keys: continue
        sim.C.update(dte_min=0, dte_max=0, delta=d)
        best, why = sim.pick(sym, date, m, right, px)
        if best is None:
            for k in keys: res[k] = why
            continue
        con, exp = best[0], best[1]
        for k in keys:
            ex = EXITS[k.split("|")[1]]
            sim.X.clear(); sim.X.update(X0); sim.X.update(ex)
            cost, steps, _ = sim.walk(sym, date, m, right, con, exp, CAL)
            res[k] = None if cost is None else round(sim.result(cost, steps), 4)
    return sig, res


def straddle(sig):
    """The first alert of the day: nearest OTM call + put, same-day expiry, one contract each. -> {variant: ret or reason}"""
    date, sym, m = sig
    spot = day(sym, date)
    px = next((b[4] for b in spot if b[0] == m), None)
    if px is None: return sig, {"all": "no_spot"}
    sim.C.update(dte_min=0, dte_max=0, delta=0.5)
    legs = {}
    for right in ("C", "P"):
        best, why = sim.pick(sym, date, m, right, px)
        if best is None: return sig, {"all": f"{right}:{why}"}
        legs[right] = best[0]
    bars = {r: {b[0]: b for b in day(legs[r], date)} for r in legs}
    out = {}
    for name, (tmax, take, stop) in STRADDLE.items():
        cost = None; last = {}; ret = None
        for t in range(m + 1, 361):
            for r in legs:
                if t in bars[r]: last[r] = bars[r][t]
            if len(last) < 2: continue
            if cost is None:
                if t > m + 3: ret = "no_fill"; break
                cost = sum(sim.mid(last[r]) for r in legs) * (1 + sim.SH); continue
            value = sum(last[r][4] for r in legs); g = value / cost - 1
            done = t - m >= tmax or t >= 360 or (take is not None and g >= take) or (stop is not None and g <= stop)
            if done:
                sold = max(sum(sim.mid(last[r]) for r in legs) * (1 - sim.SH), 0.01)
                ret = round(sold / cost - 1 - sim.COMM * 4 / (cost * 100), 4); break
        out[name] = ret if ret is not None else "no_exit"
    return sig, out


CONFIRM35 = {"stk25": ("stock", 0.25), "stk50": ("stock", 0.5), "leg30": ("leg", 0.30)}
KEEP = {"t60": "t60", "trail30": "trail30", "stop30": "stop30", "k100_t120": "k100_t120"}
WAIT35 = 60   # no confirmation by then: both legs out (the straddle's clock)
DELTA35 = float(os.environ.get("BT_STRANGLE_DELTA", "0.35"))


def strangle35(sig):
    """The user's idea (2026-10-25): on the alert, a 0.35-delta strangle; when the side is confirmed, sell the wrong leg and
    ride the right one. -> {"hold60": ret (no management), "<confirm>|<keep>": ret, ...} or reasons."""
    date, sym, m = sig
    spot = day(sym, date); sb = {b[0]: b for b in spot}
    px = sb[m][4] if m in sb else None
    if px is None: return sig, {"all": "no_spot"}
    x = ctx(sym, date)
    if not x or not x.get("sd"): return sig, {"all": "no_ctx"}
    sim.C.update(dte_min=0, dte_max=0, delta=DELTA35)
    legs = {}
    for right in ("C", "P"):
        best, why = sim.pick(sym, date, m, right, px)
        if best is None: return sig, {"all": f"{right}:{why}"}
        legs[right] = best[0]
    bars = {r: {b[0]: b for b in day(legs[r], date)} for r in legs}
    out = {}
    variants = [("hold60", None, None)] + [(f"{c}|{k}", c, k) for c in CONFIRM35 for k in KEEP]
    for name, cn, kp in variants:
        cost = None; last = {}; ret = None; paid = {}; sold_wrong = None; keep = None; peak = None; stock0 = None
        for t in range(m + 1, 361):
            for r in legs:
                if t in bars[r]: last[r] = bars[r][t]
            if len(last) < 2: continue
            if cost is None:
                if t > m + 3: ret = "no_fill"; break
                paid = {r: sim.mid(last[r]) * (1 + sim.SH) for r in legs}; cost = sum(paid.values()); stock0 = sb[t][4] if t in sb else px
                continue
            closes = {r: last[r][4] for r in legs}
            if keep is None:
                # confirmation?
                side = None
                if cn:
                    kind, k = CONFIRM35[cn]
                    if kind == "stock" and t in sb:
                        mv = sb[t][4] / stock0 - 1
                        if abs(mv) >= k * x["sd"]: side = "C" if mv > 0 else "P"
                    if kind == "leg":
                        g = {r: closes[r] / paid[r] - 1 for r in legs}
                        lead = max(g, key=g.get)
                        if g[lead] >= k and g[lead] > g[min(g, key=g.get)]: side = lead
                if side and t - m <= WAIT35:
                    wrong = "P" if side == "C" else "C"
                    sold_wrong = max(sim.mid(last[wrong]) * (1 - sim.SH), 0.01); keep = side; peak = closes[side]; kept_t = t
                    continue
                if t - m >= WAIT35 or t >= 360:   # no confirmation: both out
                    sold = max(sum(sim.mid(last[r]) for r in legs) * (1 - sim.SH), 0.01)
                    ret = round(sold / cost - 1 - sim.COMM * 4 / (cost * 100), 4); break
                continue
            # riding the kept leg
            c = closes[keep]; peak = max(peak, c); g = c / paid[keep] - 1
            done = t >= 360
            if kp == "t60": done = done or t - m >= 60
            elif kp == "trail30": done = done or c <= peak * 0.7
            elif kp == "stop30":
                against = False if t not in sb else (sb[t][4] < stock0 if keep == "C" else sb[t][4] > stock0)
                done = done or (g <= -0.30 and against)
            elif kp == "k100_t120": done = done or g >= 1.0 or t - m >= 120
            if done:
                sold = sold_wrong + max(sim.mid(last[keep]) * (1 - sim.SH), 0.01)
                ret = round(sold / cost - 1 - sim.COMM * 4 / (cost * 100), 4); break
        out[name] = ret if ret is not None else "no_exit"
    return sig, out


def entries():
    ent = []
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            if not sim.expiry_for(sym, date) == date: continue
            al = alerts_for(sym, date, CAL)
            if not al: continue
            m = next((q for q in range(FIRST, LAST + 1) if al[q]), None)
            if m is not None: ent.append((date, sym, m, al[m]))
    return ent


def strangles():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    from score_sum import account
    ent = entries()
    done = {}
    with mp.Pool(8) as pool:
        for sig, res in pool.imap_unordered(strangle35, [e[:3] for e in ent], chunksize=4): done["|".join(map(str, sig))] = res
    json.dump(done, open(f"{B}/z5_strangles_{DELTA35}.json", "w"))
    doneS = json.load(open(OUT_S))
    fair = lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]
    news = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
    Ts = []
    for date, sym, m, side in ent:
        k = "|".join(map(str, (date, sym, m)))
        Ts.append(dict(date=date, sym=sym, minute=str(m), right="C", res=done[k], base=doneS.get(k, {})))
    nf.features(Ts); Ts = [t for t in Ts if news(t) and fair(t)]
    ok = [t for t in Ts if isinstance(t["res"].get("hold60"), float)]
    print(f"\n## {DELTA35}-delta strangles on the first alert, fair list, news filter: {len(ok)} of {len(Ts)} tradeable; reasons: {collections.Counter(v for t in Ts for v in t['res'].values() if isinstance(v, str)).most_common(4)}")
    def table(rows, head):
        print(f"\n| {head} | n | win | 2024 / 2025 / 2026 per trade | without best 5 | at 1% | worst drop |\n|---|---|---|---|---|---|---|")
        for lab, T in rows:
            T = sorted(T, key=lambda x: (x[0], x[1]))
            if not T: print(f"| {lab} | 0 | | | | | |"); continue
            pn = [dict(date=d, pnl=str(1e4 * max(-1, r))) for d, m, r in T]
            eq, dd = account(pn); best5 = sorted(range(len(pn)), key=lambda i: -float(pn[i]["pnl"]))[:5]
            eq5, _ = account([x for i, x in enumerate(pn) if i not in best5])
            yr = {y: [1e4 * max(-1, r) for d, m, r in T if d[:4] == y] for y in SPAN}
            print(f"| {lab} | {len(T)} | {100 * sum(r > 0 for d, m, r in T) / len(T):.0f}% | " + " / ".join(f"{st.fmean(v):+,.0f}" if v else "" for v in yr.values())
                  + f" | ${eq5:,.0f} | ${eq:,.0f} | {100 * dd:.0f}% |")
    rows = [("near-the-money straddle, 60 min (yesterday)", [(t["date"], int(t["minute"]), t["base"]["t60"]) for t in ok if isinstance(t["base"].get("t60"), float)]),
            ("0.35 strangle, 60 min, no management", [(t["date"], int(t["minute"]), t["res"]["hold60"]) for t in ok])]
    for c in CONFIRM35:
        for k in KEEP:
            name = f"{c}|{k}"
            rows.append((f"0.35 strangle, confirm {c}, keep {k}", [(t["date"], int(t["minute"]), t["res"][name]) for t in ok if isinstance(t["res"].get(name), float)]))
    table(rows, "strangle")
    if os.environ.get("BT_BREAKDOWN"):
        import datetime as dt
        side_of = {"|".join(map(str, e[:3])): e[3] for e in ent}
        for t in ok: t["side"] = side_of["|".join((t["date"], t["sym"], t["minute"]))]
        wd = lambda t: dt.date.fromisoformat(t["date"]).weekday()
        for name in ("stk25|trail30", "stk25|t60"):
            rows = lambda pred: [(t["date"], int(t["minute"]), t["res"][name]) for t in ok if pred(t) and isinstance(t["res"].get(name), float)]
            table([(f"{name}, {lab}", rows(pred)) for lab, pred in (("Friday", lambda t: wd(t) == 4), ("not Friday", lambda t: wd(t) != 4),
                   ("alert up", lambda t: t["side"] == "up"), ("alert down", lambda t: t["side"] == "down"),
                   ("09:40-10:30", lambda t: int(t["minute"]) <= 60), ("10:30-12:00", lambda t: 60 < int(t["minute"]) <= 150), ("12:00-13:00", lambda t: int(t["minute"]) > 150))], name)
            by = collections.defaultdict(list)
            for t in ok:
                if isinstance(t["res"].get(name), float): by[t["sym"]].append(1e4 * max(-1, t["res"][name]))
            print(f"{name} by stock, best: " + ", ".join(f"{s_} {len(v)} {sum(v)/1e3:+,.0f}K" for s_, v in sorted(by.items(), key=lambda kv: -sum(kv[1]))[:8]))
            print(f"{name} by stock, worst: " + ", ".join(f"{s_} {len(v)} {sum(v)/1e3:+,.0f}K" for s_, v in sorted(by.items(), key=lambda kv: sum(kv[1]))[:5]))
            v = sorted((1e4 * max(-1, t["res"][name]) for t in ok if isinstance(t["res"].get(name), float)), reverse=True)
            print(f"{name}: top 5 {[f'{x:+,.0f}' for x in v[:5]]}, median {st.median(v):+,.0f}, over +50%: {100*sum(x > 5000 for x in v)/len(v):.0f}%, under -30%: {100*sum(x < -3000 for x in v)/len(v):.0f}%")


def run():
    with mp.Pool(8) as pool: parts = pool.map(stock, P["universe"])
    S, tags = collections.defaultdict(list), {}
    for out, tg in parts:
        for date, sym, m, right, rule in out: S[(date, sym, m, right)].append(rule)
        tags.update({"|".join(map(str, k)): v for k, v in tg.items()})
    print(len(S), "distinct signals", flush=True)
    done = json.load(open(OUT)) if os.path.exists(OUT) else {}
    z4 = json.load(open(Z4)) if os.path.exists(Z4) else {}
    jobs = []
    for k in S:
        kk = "|".join(map(str, k))
        rec = done.setdefault(kk, dict(rules=S[k], res={}, tags=tags.get(kk, {})))
        rec["rules"] = S[k]; rec["tags"] = tags.get(kk, {})
        for key in list(rec["res"]): pass
        for d in DELTAS:
            for ex in EXITS:
                key = f"{d}|{ex}"
                if key in rec["res"]: continue
                if ex in BASE and kk in z4 and key in z4[kk]["res"]: rec["res"][key] = z4[kk]["res"][key]  # zero4 walked this one
        need = [f"{d}|{ex}" for d in DELTAS for ex in EXITS if f"{d}|{ex}" not in rec["res"]]
        if need: jobs.append((k, need))
    print(len(jobs), "signals need walks", flush=True)
    with mp.Pool(8) as pool:
        for i, (sig, res) in enumerate(pool.imap_unordered(walk, jobs, chunksize=4)):
            done["|".join(map(str, sig))]["res"].update(res)
            if i % 500 == 0: print(i, "/", len(jobs), flush=True); json.dump(done, open(OUT, "w"))
    json.dump(done, open(OUT, "w")); print("walks done", flush=True)
    # straddles: the first alert of each expiry day, fair-list stocks, 09:40-13:00
    ent = []
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            if not sim.expiry_for(sym, date) == date: continue
            al = alerts_for(sym, date, CAL)
            if not al: continue
            m = next((q for q in range(FIRST, LAST + 1) if al[q]), None)
            if m is not None: ent.append((date, sym, m))
    print(len(ent), "straddle entries", flush=True)
    doneS = json.load(open(OUT_S)) if os.path.exists(OUT_S) else {}
    todo = [e for e in ent if "|".join(map(str, e)) not in doneS]
    with mp.Pool(8) as pool:
        for i, (sig, res) in enumerate(pool.imap_unordered(straddle, todo, chunksize=4)):
            doneS["|".join(map(str, sig))] = res
            if i % 200 == 0: print(i, "/", len(todo), flush=True); json.dump(doneS, open(OUT_S, "w"))
    json.dump(doneS, open(OUT_S, "w")); print("done", flush=True)


def straddles():
    """Every straddle again (new exit variants), then the breakdown."""
    import datetime as dt, news_filter as nf
    from low_delta import HIS40, PRIOR
    from score_sum import account
    ent = []
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            if not sim.expiry_for(sym, date) == date: continue
            al = alerts_for(sym, date, CAL)
            if not al: continue
            m = next((q for q in range(FIRST, LAST + 1) if al[q]), None)
            if m is not None: ent.append((date, sym, m, al[m]))
    doneS = {}
    with mp.Pool(8) as pool:
        for sig, res in pool.imap_unordered(straddle, [e[:3] for e in ent], chunksize=4): doneS["|".join(map(str, sig))] = res
    json.dump(doneS, open(OUT_S, "w"))
    fair = lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]
    news = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
    Ts = []
    for date, sym, m, side in ent:
        r = doneS["|".join(map(str, (date, sym, m)))]
        Ts.append(dict(date=date, sym=sym, minute=str(m), right="C", side=side, res=r))
    nf.features(Ts); Ts = [t for t in Ts if news(t) and fair(t) and isinstance(t["res"].get("t60"), float)]
    print(f"\n## Straddles, fair list, news filter, both legs liquid: {len(Ts)}")
    def table(rows, head):
        print(f"\n| {head} | n | win | 2024 / 2025 / 2026 per trade | without best 5 | at 1% | worst drop |\n|---|---|---|---|---|---|---|")
        for lab, T in rows:
            T = sorted(T, key=lambda x: (x[0], x[1]))
            if not T: print(f"| {lab} | 0 | | | | | |"); continue
            pn = [dict(date=d, pnl=str(1e4 * max(-1, r))) for d, m, r in T]
            eq, dd = account(pn); best5 = sorted(range(len(pn)), key=lambda i: -float(pn[i]["pnl"]))[:5]
            eq5, _ = account([x for i, x in enumerate(pn) if i not in best5])
            yr = {y: [1e4 * max(-1, r) for d, m, r in T if d[:4] == y] for y in SPAN}
            print(f"| {lab} | {len(T)} | {100 * sum(r > 0 for d, m, r in T) / len(T):.0f}% | " + " / ".join(f"{st.fmean(v):+,.0f}" if v else "" for v in yr.values())
                  + f" | ${eq5:,.0f} | ${eq:,.0f} | {100 * dd:.0f}% |")
    rows = lambda name, pred=lambda t: True: [(t["date"], int(t["minute"]), t["res"][name]) for t in Ts if pred(t) and isinstance(t["res"].get(name), float)]
    table([(n, rows(n)) for n in STRADDLE], "exit")
    wd = lambda t: dt.date.fromisoformat(t["date"]).weekday()
    table([(f"t60, {lab}", rows("t60", pred)) for lab, pred in (("Friday", lambda t: wd(t) == 4), ("not Friday", lambda t: wd(t) != 4),
           ("alert up", lambda t: t["side"] == "up"), ("alert down", lambda t: t["side"] == "down"),
           ("alert 09:40-10:30", lambda t: int(t["minute"]) <= 60), ("10:30-12:00", lambda t: 60 < int(t["minute"]) <= 150), ("12:00-13:00", lambda t: int(t["minute"]) > 150))], "t60 by")
    by = collections.defaultdict(list)
    for t in Ts: by[t["sym"]].append(1e4 * max(-1, t["res"]["t60"]))
    print("\nt60 by stock (n, per trade, sum): " + ", ".join(f"{s} {len(v)} {st.fmean(v):+,.0f} {sum(v)/1e3:+,.0f}K" for s, v in sorted(by.items(), key=lambda kv: -sum(kv[1]))[:12]))
    print("t60 worst stocks: " + ", ".join(f"{s} {len(v)} {sum(v)/1e3:+,.0f}K" for s, v in sorted(by.items(), key=lambda kv: sum(kv[1]))[:5]))
    v = sorted((1e4 * max(-1, t["res"]["t60"]) for t in Ts), reverse=True)
    print(f"t60 top 5 trades: {[f'{x:+,.0f}' for x in v[:5]]}; median trade {st.median(v):+,.0f}; share of trades over +50%: {100*sum(x > 5000 for x in v)/len(v):.0f}%, under -30%: {100*sum(x < -3000 for x in v)/len(v):.0f}%")


def summary():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    from score_sum import account
    fair = lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]
    news = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
    def table(rows, head):
        print(f"\n| {head} | n | win | 2024 / 2025 / 2026 per trade | without best 5 | at 1% | worst drop |\n|---|---|---|---|---|---|---|")
        for lab, rets in rows:
            T = sorted(rets, key=lambda x: (x[0], x[1]))
            if not T: print(f"| {lab} | 0 | | | | | |"); continue
            pn = [dict(date=d, pnl=str(1e4 * max(-1, r))) for d, m, r in T]
            eq, dd = account(pn)
            best5 = sorted(range(len(pn)), key=lambda i: -float(pn[i]["pnl"]))[:5]
            eq5, _ = account([x for i, x in enumerate(pn) if i not in best5])
            yr = {y: [1e4 * max(-1, r) for d, m, r in T if d[:4] == y] for y in SPAN}
            print(f"| {lab} | {len(T)} | {100 * sum(r > 0 for d, m, r in T) / len(T):.0f}% | " + " / ".join(f"{st.fmean(v):+,.0f}" if v else "" for v in yr.values())
                  + f" | ${eq5:,.0f} | ${eq:,.0f} | {100 * dd:.0f}% |")
    D = json.load(open(OUT))
    T = []
    for k, v in D.items():
        date, sym, m, right = k.split("|")
        T.append(dict(date=date, sym=sym, minute=m, right=right, rules=v["rules"], res=v["res"], tags=v.get("tags", {})))
    nf.features(T); T = [t for t in T if news(t) and fair(t)]
    sel = lambda rule, key, pred=lambda t: True: [(t["date"], int(t["minute"]), t["res"][key]) for t in T if rule in t["rules"] and pred(t) and isinstance(t["res"].get(key), float)]
    print(f"\n## 0DTE, fair list, news filter: {len(T)} breakout signals\n\n### 1. The alert-silence exit (baseline exit vs the same with 'no alert within 30 min -> out')")
    for kind in ("any", "prev", "day"):
        for cname in ("c1", "c2"):
            rule = f"{kind}|{cname}"
            rows = []
            for d in DELTAS:
                for ex in BASE:
                    rows.append((f"{rule} δ{d} {ex}", sel(rule, f"{d}|{ex}"))); rows.append((f"{rule} δ{d} {ex} + silence 30", sel(rule, f"{d}|{ex}_as30")))
                rows.append((f"{rule} δ{d} S + silence 15", sel(rule, f"{d}|S_as15")))
            table(rows, rule)
    print("\n### 2. The alert-confirmed entry (the same strategies, only breakouts with a same-side alert in the last 5 / 15 minutes)")
    for kind in ("any", "prev"):
        for cname in ("c1", "c2"):
            rule = f"{kind}|{cname}"; rows = []
            for d in DELTAS:
                for ex in ("S", "THIRDS"):
                    key = f"{d}|{ex}"
                    rows += [(f"{rule} δ{d} {ex}: all", sel(rule, key)), (f"  alert in last 5 min", sel(rule, key, lambda t: t["tags"].get("a5"))),
                             (f"  alert in last 15 min", sel(rule, key, lambda t: t["tags"].get("a15"))), (f"  no alert in last 15 min", sel(rule, key, lambda t: not t["tags"].get("a15")))]
            table(rows, rule)
    print("\n### 4. The alert as a bonus (volume counts 1.5x for 15 minutes after a same-side alert): c1b / c2b vs c1 / c2")
    for kind in ("any", "prev", "day"):
        rows = []
        for cname in ("c1", "c2"):
            for d in DELTAS:
                for ex in ("S", "THIRDS"):
                    rows += [(f"{kind}|{cname} δ{d} {ex}", sel(f"{kind}|{cname}", f"{d}|{ex}")), (f"{kind}|{cname}b δ{d} {ex}", sel(f"{kind}|{cname}b", f"{d}|{ex}"))]
        table(rows, kind)
    if os.path.exists(OUT_S):
        Ds = json.load(open(OUT_S)); Ts = []
        for k, v in Ds.items():
            date, sym, m = k.split("|"); Ts.append(dict(date=date, sym=sym, minute=m, right="C", res=v))
        nf.features(Ts); Ts = [t for t in Ts if news(t) and fair(t)]
        print(f"\n### 3. The alert straddle: {len(Ts)} first-alerts on expiry days (fair list, news filter); reasons: {collections.Counter(v for t in Ts for v in t['res'].values() if isinstance(v, str)).most_common(4)}")
        table([(name, [(t["date"], int(t["minute"]), t["res"][name]) for t in Ts if isinstance(t["res"].get(name), float)]) for name in STRADDLE], "straddle exit")


if __name__ == "__main__":
    {"run": run, "straddles": straddles, "strangles": strangles, "summary": summary}[sys.argv[1]]()
