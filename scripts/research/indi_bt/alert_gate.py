"""V2: the site's volume alert (rvol-v6) as a second way through the C signal's volume gate.

The champion (t >= 1.8, day volume >= 1.5x, news filter) is often late when a quiet morning turns on one burst: the
strength test is met minutes before the day's total catches up (ORCL 2026-09-29: t >= 1.8 at 10:17, the alert at 10:18,
the bot at 10:27 at the top). Here the alert engine's own rule stands in for the day-volume condition:

  ag<W>   t >= 1.8 and (day volume >= 1.5x, or an rvol-v6 alert in the bet direction in the last W minutes)

The alert, as packages/alerts/src/relative-volume.ts on regular-session 1-minute bars: over the last 3 bars, volume
>= 4x the median of the same 3 minutes over the prior 20 sessions (or >= 4x today's pace mid-session), >= 10,000
shares, the move from the close before the window >= 3x the median |move| of the same minutes and >= 0.5%, and the
last bar closing beyond the previous close with a candle of that colour. Cooldown and "fresh crossing" are not
applied: the bot would read evaluations, not delivered alerts. Deviations from the live engine: regular hours only
(the cache has no pre/post bars), and >= 10 prior sessions with data instead of exactly 20.

  python3 alert_gate.py signals [years...]     (from the repo root, BT_UNIVERSE=wide)
      -> data/local/x/bt/s_sig_<rule>_<year>.csv (every signal, with `route` and `alert_minute`)
         data/local/x/bt/s_sig_<rule>d_<year>.csv (only stock-days whose signal differs from the champion's)
         and a check that the regenerated t18r15 signals equal s_sig_t18r15_<year>.csv
  python3 alert_gate.py round [rules...]        -> the champion's trade (score_round) on the d files
  python3 alert_gate.py fade [rules...]         -> the d files again with the volume-fade exit (sim.py vol_fade) at 5 / 10 / 20 min
  python3 alert_gate.py summary                 -> champion vs each rule (and its fade variants), fair list and 151 unseen
"""
import csv, glob, math, multiprocessing as mp, os, statistics as st, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("BT_UNIVERSE", "wide")
from store import P, day, calendar
from signals import series, beta

B = "data/local/x/bt"
SPAN = {"2024": ("2024-02-01", "2024-12-31"), "2025": ("2025-01-02", "2025-12-31"), "2026": ("2026-01-02", "2026-10-12")}
FIRST, LAST, MIN_STEPS = 10, 374, 10
T_MIN, RV_MIN = 1.8, 1.5
# The alert's rule (rvol-v6 defaults).
WIN, THRESHOLD, PACE, MIN_VOL, PRICE_MULT, MIN_MOVE = 3, 4.0, 4.0, 10000, 3.0, 0.5
PACE_SKIP_OPEN, PACE_SKIP_CLOSE, PACE_MIN_MINUTES = 30, 30, 15
TAG = os.environ.get("BT_TAG", "")  # output prefix s<TAG>_... (the champion at the same contract rules: s<TAG>_t18r15)
# name -> (alert window in minutes, day-volume floor on the alert route); None: the champion, as a check
RULES = {"t18r15": None, "ag5": (5, 0.0), "ag15": (15, 0.0), "ag5r10": (5, 1.0)}
if os.environ.get("BT_RULES"): RULES = {k: RULES[k] for k in os.environ["BT_RULES"].split(",")}


def med(v):
    v = sorted(v); k = len(v) // 2
    return v[k] if len(v) % 2 else (v[k - 1] + v[k]) / 2


def windows(bars):
    """Per minute m: (window volume, |move| %) over bars m-2..m against the close at m-3, when those bars are all
    present and contiguous; else None. Also the opens, closes, volumes and a presence flag by minute."""
    by = {b[0]: b for b in bars}
    out = [None] * 390
    for m in range(WIN, 390):
        if all(k in by for k in range(m - WIN, m + 1)):
            vol = sum(by[k][5] for k in range(m - WIN + 1, m + 1))
            move = abs(by[m][4] / by[m - WIN][4] - 1) * 100
            out[m] = (vol, move)
    return out, by


def alerts(bars, hist):
    """The alert's direction ('up' / 'down') or None at each minute of a day; hist: prior days' windows()."""
    w, by = windows(bars)
    out = [None] * 390
    pace_vol, pace_n = 0, 0            # today's pace zone before the window
    pace = lambda m: PACE_SKIP_OPEN <= m <= 389 - PACE_SKIP_CLOSE
    for m in range(390):
        b = by.get(m)
        # pace zone volume up to and including the bar before the window (m - WIN)
        k = m - WIN
        if k >= 0 and pace(k) and k in by: pace_vol += by[k][5]; pace_n += 1
        if w[m] is None or b is None: continue
        actual, move = w[m]
        samples = [h[m] for h in hist if h[m] is not None]
        if len(samples) < 10: continue
        expected, expected_move = med([s[0] for s in samples]), med([s[1] for s in samples])
        ratio = actual / expected if expected > 0 else None
        in_pace = all(pace(k) for k in range(m - WIN + 1, m + 1))
        pace_ratio = actual / (pace_vol / pace_n * WIN) if in_pace and pace_n >= PACE_MIN_MINUTES and pace_vol > 0 else None
        volume_ok = (ratio is not None and ratio >= THRESHOLD) or (pace_ratio is not None and pace_ratio >= PACE)
        move_ok = move >= PRICE_MULT * expected_move and move >= MIN_MOVE
        if not (volume_ok and move_ok and actual >= MIN_VOL): continue
        prev = by[m - 1][4]
        if b[4] > prev and b[4] > b[1]: out[m] = "up"
        elif b[4] < prev and b[4] < b[1]: out[m] = "down"
    return out


def stock(sym):
    cal = calendar(); out = {k: [] for k in RULES}
    spans = [SPAN[y] for y in YEARS]
    wcache = {}
    def W(d):
        if d not in wcache: wcache[d] = windows(day(sym, d))[0]
        return wcache[d]
    for i, date in enumerate(cal):
        if not any(a <= date <= b for a, b in spans) or i < 21: continue
        bars = day(sym, date)
        if len(bars) <= 300: continue
        b_ = beta(sym, date, i, cal)
        if b_ is None: continue
        hist = []
        for d in cal[i - 20:i]:
            v = [0] * 390
            for x in day(sym, d): v[x[0]] = x[5]
            acc, cum = 0, []
            for x in v: acc += x; cum.append(acc)
            if cum[-1] > 0: hist.append(cum)
        if len(hist) < 10: continue
        al = alerts(bars, [W(d) for d in cal[i - 20:i]])
        c = series(bars)[0]; spy = series(day("SPY", date))[0]
        vol = [0] * 390
        for x in bars: vol[x[0]] = x[5]
        cum, acc = [], 0
        for x in vol: acc += x; cum.append(acc)
        n = s1 = s2 = 0.0
        left = set(RULES)
        for m in range(1, LAST + 1):
            if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
                x = (c[m] / c[m - 1] - 1) - b_ * (spy[m] / spy[m - 1] - 1)
                n += 1; s1 += x; s2 += x * x
            if m < FIRST or n < MIN_STEPS or c[m] is None: continue
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
            usual = med([h[m] for h in hist])
            rv = cum[m] / usual if usual else 0.0
            for name in list(left):
                wdw = RULES[name]
                for side, tt, want in (("C", t, "up"), ("P", -t, "down")):
                    if tt < T_MIN: continue
                    route, am = None, ""
                    if rv >= RV_MIN: route = "day"
                    elif wdw and rv >= wdw[1]:
                        hit = [k for k in range(max(0, m - wdw[0] + 1), m + 1) if al[k] == want]
                        if hit: route, am = "alert", hit[0]
                    if route is None: continue
                    left.discard(name)
                    out[name].append(dict(date=date, sym=sym, right=side, minute=m, time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}",
                                          price=c[m], b_minute="", a_minute="", c_t=round(abs(t), 2), c_rvol=round(rv, 2), sector="",
                                          route=route, alert_minute=am))
                    break
            if not left: break
    return out


YEARS = [a for a in sys.argv[2:] if a[:2] == "20"] or list(SPAN)


def signals():
    with mp.Pool(8) as pool: parts = pool.map(stock, P["universe"])
    champ = {}
    for y in YEARS:
        for r in csv.DictReader(open(f"{B}/s_sig_t18r15_{y}.csv")): champ[(r["date"], r["sym"])] = (int(r["minute"]), r["right"])
    for name in RULES:
        rows = sorted((r for p in parts for r in p[name]), key=lambda r: (r["date"], r["sym"]))
        for y in YEARS:
            ys = [r for r in rows if r["date"][:4] == y]
            with open(f"{B}/s_sig_{name}_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(ys[0])); w.writeheader(); w.writerows(ys)
            if RULES[name] is None:
                mine = {(r["date"], r["sym"]): (r["minute"], r["right"]) for r in ys}
                ref = {k: v for k, v in champ.items() if k[0][:4] == y}
                diff = sum(1 for k in set(mine) | set(ref) if mine.get(k) != ref.get(k))
                print(f"{name} {y}: {len(ys)} signals, {diff} differ from s_sig_t18r15_{y}.csv", flush=True)
                continue
            d = [r for r in ys if champ.get((r["date"], r["sym"])) != (r["minute"], r["right"])]
            earlier = sum(1 for r in d if (r["date"], r["sym"]) in champ)
            with open(f"{B}/s_sig_{name}d_{y}.csv", "w") as f:
                w = csv.DictWriter(f, fieldnames=list(ys[0])); w.writeheader(); w.writerows(d)
            print(f"{name} {y}: {len(ys)} signals, {len(d)} differ from the champion ({earlier} earlier on the same day, {len(d) - earlier} new days)", flush=True)


FADES = {"vf5": 5, "vf10": 10, "vf20": 20}   # the volume-fade exit: the ratio lower than N minutes earlier


def round_(suffix="", extra=None):
    from tiers_round import H, NIGHT, R
    import json
    env = dict(os.environ, BT_VARIANT="v2", BT_UNIVERSE="wide", BT_FLAT="1", BT_EXIT=json.dumps(dict(H, **NIGHT, **(extra or {}))))
    jobs = []
    for rule in [a for a in sys.argv[2:] if a[:2] != "20"] or [k for k in RULES if RULES[k]]:
        for y in YEARS:
            out = f"{B}/s{TAG}_{rule}d{suffix}_{y}"
            if all(os.path.exists(f"{out}.{i}_trades.csv") for i in range(4)): continue
            for i in range(4):
                jobs.append((["node", "--env-file=.env", R, "tiers.py", f"{B}/s_sig_{rule}d_{y}.csv", out, f"{i}/4"], f"{out}.{i}.log"))
    running = []
    while jobs or running:
        while jobs and len(running) < 8:
            args, log = jobs.pop(0)
            with open(log, "w") as f: running.append(subprocess.Popen(args, env=env, stdout=f, stderr=subprocess.STDOUT))
        running[0].wait(); running = [p for p in running if p.poll() is None]
    print("done", flush=True)


def fade():
    """The rule's changed days again, with the volume-fade exit at each window -> s<TAG>_<rule>d_<vf>_<year>."""
    for suf, n in FADES.items(): round_(f"_{suf}", {"vol_fade": {"min": n, "until": RV_MIN}})


def summary():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    from score_sum import account
    lists = [("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]),
             ("151 unseen", lambda t: t["sym"] not in HIS40)]
    news = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
    key = lambda t: (t["date"], t["sym"])
    champ = [t for f in glob.glob(f"{B}/s{TAG}_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(champ); champ = sorted((t for t in champ if news(t)), key=lambda t: (t["date"], int(t["minute"])))
    champ_signals = {key(r) for y in SPAN for r in csv.DictReader(open(f"{B}/s_sig_t18r15_{y}.csv"))}
    champ_by = {key(t): t for t in champ}
    print(f"Champion (s{TAG}_t18r15, min_vol30 {P['contract']['min_vol30']}): {len(champ)} trades after the news filter")
    for name in [k for k in RULES if RULES[k]]:
        dsig = {key(r): r for y in SPAN if os.path.exists(f"{B}/s_sig_{name}d_{y}.csv") for r in csv.DictReader(open(f"{B}/s_sig_{name}d_{y}.csv"))}
        variants = [("", name)] + [(f"_{suf}", f"{name} + volume fade {n} min") for suf, n in FADES.items()
                                    if glob.glob(f"{B}/s{TAG}_{name}d_{suf}_20*.[0-9]_trades.csv")]
        Dv = {}
        for suf, lab in variants:
            Dv[suf] = [t for f in glob.glob(f"{B}/s{TAG}_{name}d{suf}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
            nf.features(Dv[suf]); Dv[suf] = [t for t in Dv[suf] if news(t)]
            rules = {r["id"]: r["rules"] for f in glob.glob(f"{B}/s{TAG}_{name}d{suf}_20*.[0-9]_legs.csv") for r in csv.DictReader(open(f))}
            for t in Dv[suf]: t["route"] = dsig[key(t)]["route"]; t["moved"] = key(t) in champ_signals; t["rules"] = rules.get(t["id"], "")
        D = Dv[""]
        if not D: print(f"\n{name}: no trades yet"); continue
        print(f"\n## {name}: t >= 1.8 and (day volume >= 1.5x or an alert our way in the last {RULES[name][0]} minutes with day volume >= {RULES[name][1]}x)\n")
        print(f"Signals that differ from the champion's: {len(dsig)} ({sum(1 for k in dsig if k in champ_signals)} earlier on a champion day, "
              f"{sum(1 for k in dsig if k not in champ_signals)} new days); {len(D)} of them traded after the news filter.")
        for lname, lf in lists:
            L = [t for t in champ if lf(t)]
            Ld = [t for t in D if lf(t)]
            kept = [t for t in L if key(t) not in dsig]
            A = sorted(kept + Ld, key=lambda t: (t["date"], int(t["minute"])))
            print(f"\n### {lname}\n")
            print("| Version | Trades | Winners | 2024 / 2025 / 2026 per trade | Without best 5 (24 / 25 / 26) | At 1% | At 2% |\n|---|---|---|---|---|---|---|")
            def line(lab, A):
                yr = {y: sorted(float(t["pnl"]) for t in A if t["date"][:4] == y) for y in ("2024", "2025", "2026")}
                a1, d1 = account(A); a2, d2 = account(A, 0.02)
                pnl = [float(t["pnl"]) for t in A]
                print(f"| {lab} | {len(A)} | {100 * sum(x > 0 for x in pnl) / max(len(pnl), 1):.0f}% | " + " / ".join(f"{st.fmean(v):+,.0f}" if v else "" for v in yr.values())
                      + " | " + " / ".join(f"{sum(v[:-5]) / 1e3:+,.0f}K" for v in yr.values())
                      + f" | ${a1:,.0f}, {100 * d1:.0f}% | ${a2:,.0f}, {100 * d2:.0f}% |")
            line("champion", L)
            line(name, A)
            for suf, lab in variants[1:]:
                Lv = [t for t in Dv[suf] if lf(t)]
                Av = sorted(kept + Lv, key=lambda t: (t["date"], int(t["minute"])))
                line(lab, Av)
                faded = [t for t in Lv if "V_fade" in t.get("rules", "")]
                paired = [(t, next(x for x in Ld if key(x) == key(t))) for t in faded if any(key(x) == key(t) for x in Ld)]
                if paired: print(f"  {lab}: {len(faded)} trades cut by the fade, {sum(float(a['pnl']) > 0 for a, b in paired)} winners after vs {sum(float(b['pnl']) > 0 for a, b in paired)} before, "
                                 f"{st.fmean(float(a['pnl']) for a, b in paired):+,.0f} vs {st.fmean(float(b['pnl']) for a, b in paired):+,.0f} a trade")
            # the changed trades, paired with what the champion did on the same stock-day
            moved = [t for t in Ld if t["moved"]]
            old = [champ_by[key(t)] for t in moved if key(t) in champ_by]
            dropped = [t for t in L if key(t) in dsig and key(t) not in {key(x) for x in Ld}]
            new = [t for t in Ld if not t["moved"]]
            print(f"\nEarlier entries on champion days: {len(moved)} trades, {sum(float(t['pnl']) > 0 for t in moved)} winners, "
                  f"{st.fmean(float(t['pnl']) for t in moved):+,.0f} a trade" if moved else "\nEarlier entries on champion days: none")
            if old: print(f"  the champion's own trades on {len(old)} of those days: {sum(float(t['pnl']) > 0 for t in old)} winners, {st.fmean(float(t['pnl']) for t in old):+,.0f} a trade")
            if dropped: print(f"  champion trades lost because the earlier signal found no contract or was filtered: {len(dropped)}, {st.fmean(float(t['pnl']) for t in dropped):+,.0f} a trade")
            print(f"New days (the day's volume never reached 1.5x by the signal): {len(new)} trades, {sum(float(t['pnl']) > 0 for t in new)} winners, "
                  f"{st.fmean(float(t['pnl']) for t in new):+,.0f} a trade" if new else "New days: none")
            best = sorted(Ld, key=lambda t: -float(t["pnl"]))[:5]
            print("  best changed trades: " + ", ".join(f"{t['sym']} {t['date']} {float(t['pnl']):+,.0f}" for t in best))
            worst = sorted(Ld, key=lambda t: float(t["pnl"]))[:3]
            print("  worst: " + ", ".join(f"{t['sym']} {t['date']} {float(t['pnl']):+,.0f}" for t in worst))


if __name__ == "__main__":
    {"signals": signals, "round": round_, "fade": fade, "summary": summary}[sys.argv[1]]()
