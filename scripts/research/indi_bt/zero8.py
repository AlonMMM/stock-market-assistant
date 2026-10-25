"""V2: the alert strangle, two more questions (the user, 2026-10-25).
1. Does the bot's direction pick the leg to drop better than the stock's raw move? Confirmations:
     move25     the stock 0.25 S30 from the fill (the rule so far)
     tsign      at the fill, drop the leg against the sign of the C t-stat (strength vs SPY x beta since the open)
     tsign1     the same, only when |t| >= 1.0; else fall back to move25
     tsign18    the same at the bot's threshold |t| >= 1.8; else move25
     csignal    wait for the bot's full C signal (t >= 1.8 and day volume >= 1.5x) within 60 min; drop the other leg; else both out
     agree      move25, accepted only when it agrees with the t-stat's sign; else keep waiting (both out at 60)
   each plain and with the D bonus (the wrong leg's proceeds into the kept leg). Same-day expiry, delta 0.35, trail 30%.
2. Not only 0DTE: the same rule with the bot's expiry (nearest 1-7 days out), on every day's first alert, same-day
   exits (trail 30% to 15:30). Needs option bars the cache lacks: BT_YEARS limits it (default 2026).

  node --env-file=.env <path>/run.mjs zero8.py direction   -> z8_direction.json and the table
  node --env-file=.env <path>/run.mjs zero8.py dte         -> z8_dte.json and the table (BT_YEARS=2026)
"""
import collections, json, math, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import P, day, calendar
from signals import series, beta
from levels import ctx
from rvol_alert import alerts_for
import zero5, zero6

B = "data/local/x/bt"
SPAN = zero5.SPAN
DELTA, WAIT, TRAIL = 0.35, 60, 0.30
FILLS = (0.02, 0.04)
CONFIRMS = ("move25", "tsign", "tsign1", "tsign18", "csignal", "agree")
CAL = calendar()
YEARS = os.environ.get("BT_YEARS", "2026").split(",")


def c_series(sym, date):
    """Per minute: the C t-stat (1-minute moves vs SPY x beta since the open) and the day-volume ratio; None without data."""
    i = CAL.index(date); b_ = beta(sym, date, i, CAL)
    if b_ is None: return None, None
    hist = []
    for d in CAL[i - 20:i]:
        v = [0] * 390
        for x in day(sym, d): v[x[0]] = x[5]
        acc, cum = 0, []
        for x in v: acc += x; cum.append(acc)
        if cum[-1] > 0: hist.append(cum)
    if len(hist) < 10: return None, None
    c = series(day(sym, date))[0]; s = series(day("SPY", date))[0]
    vol = [0] * 390
    for x in day(sym, date): vol[x[0]] = x[5]
    cum, acc = [], 0
    for x in vol: acc += x; cum.append(acc)
    T, RV = [None] * 390, [None] * 390
    n = s1 = s2 = 0.0
    for m in range(1, 390):
        if c[m] and c[m - 1] and s[m] and s[m - 1]:
            r = (c[m] / c[m - 1] - 1) - b_ * (s[m] / s[m - 1] - 1); n += 1; s1 += r; s2 += r * r
        if n >= 10:
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            T[m] = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
        med = sorted(h[m] for h in hist); k = len(med) // 2
        u = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
        RV[m] = cum[m] / u if u else None
    return T, RV


def walk_pair(sym, date, m, dte):
    """Pick both legs, return the fill and the path (as zero6/zero7), or a reason."""
    sb = {b[0]: b for b in day(sym, date)}
    if m not in sb: return None, "no_spot"
    px = sb[m][4]
    sim.C.update(dte_min=dte[0], dte_max=dte[1], delta=DELTA)
    legs = {}
    for right in ("C", "P"):
        best, why = sim.pick(sym, date, m, right, px)
        if best is None: return None, f"{right}:{why}"
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
        path.append((t, {r: last[r][4] for r in legs}, {r: sim.mid(last[r]) for r in legs}, sb[t][4] if t in sb else None))
    if fill_t is None or not path: return None, "no_fill"
    return dict(legs=legs, fill_t=fill_t, fill_mid=fill_mid, path=path, stock0=sb[fill_t][4] if fill_t in sb else px), None


def settle(pair, m, sd, conf_fn, sh, recycle):
    """conf_fn(t, spot_move) -> side or None. -> ret."""
    legs, path, fill_mid, stock0 = pair["legs"], pair["path"], pair["fill_mid"], pair["stock0"]
    paid = {r: fill_mid[r] * (1 + sh) for r in legs}; cost = sum(paid.values())
    sell1 = lambda mid_: max(mid_ * (1 - sh), 0.01)
    conf = None
    for t, closes, mids, spot in path:
        if t - m > WAIT: break
        side = conf_fn(t, (spot / stock0 - 1) if spot else None, sd)
        if side: conf = (t, side); break
    comm = sim.COMM * (6 if recycle else 4) / (cost * 100)
    if conf is None:
        row = next((p for p in path if p[0] - m >= WAIT), path[-1])
        return round(sum(sell1(row[2][r]) for r in legs) / cost - 1 - comm, 4)
    ct, keep = conf; wrong = "P" if keep == "C" else "C"
    crow = next(p for p in path if p[0] == ct)
    sold_wrong = sell1(crow[2][wrong]); units = 1.0
    if recycle: units += sold_wrong / (crow[2][keep] * (1 + sh)); sold_wrong = 0.0
    peak = crow[1][keep]
    for t, closes, mids, spot in path:
        if t <= ct: continue
        c = closes[keep]; peak = max(peak, c)
        if t >= 360 or c <= peak * (1 - TRAIL): return round((sold_wrong + units * sell1(mids[keep])) / cost - 1 - comm, 4)
    t, closes, mids, spot = path[-1]
    return round((sold_wrong + units * sell1(mids[keep])) / cost - 1 - comm, 4)


def one_direction(sig):
    date, sym, m = sig
    x = ctx(sym, date)
    if not x or not x.get("sd"): return sig, None
    pair, why = walk_pair(sym, date, m, (0, 0))
    if pair is None: return sig, {"skip": why}
    T, RV = c_series(sym, date)
    if T is None: return sig, {"skip": "no_c"}
    sd = x["sd"]; t0 = T[pair["fill_t"]]
    sign = lambda v: "C" if v > 0 else "P"
    move = lambda t, mv, sd_: (sign(mv) if mv is not None and abs(mv) >= 0.25 * sd_ else None)
    fns = {
        "move25": move,
        "tsign": lambda t, mv, sd_: sign(t0) if t0 is not None else move(t, mv, sd_),
        "tsign1": lambda t, mv, sd_: sign(t0) if t0 is not None and abs(t0) >= 1.0 else move(t, mv, sd_),
        "tsign18": lambda t, mv, sd_: sign(t0) if t0 is not None and abs(t0) >= 1.8 else move(t, mv, sd_),
        "csignal": lambda t, mv, sd_: (sign(T[t]) if T[t] is not None and abs(T[t]) >= 1.8 and (RV[t] or 0) >= 1.5 and t >= 10 else None),
        "agree": lambda t, mv, sd_: (move(t, mv, sd_) if move(t, mv, sd_) and T[t] is not None and move(t, mv, sd_) == sign(T[t]) else None),
    }
    res = {"t0": round(t0, 2) if t0 is not None else None}
    for sh in FILLS:
        for cn, fn in fns.items():
            res[f"{sh}|{cn}"] = settle(pair, m, sd, fn, sh, False)
            res[f"{sh}|{cn}|D"] = settle(pair, m, sd, fn, sh, True)
    return sig, res


def one_dte(sig):
    date, sym, m = sig
    x = ctx(sym, date)
    if not x or not x.get("sd"): return sig, None
    sd = x["sd"]; sign = lambda v: "C" if v > 0 else "P"
    move = lambda t, mv, sd_: (sign(mv) if mv is not None and abs(mv) >= 0.25 * sd_ else None)
    res = {}
    for name, dte in (("0dte", (0, 0)), ("dte1_7", (1, 7))):
        pair, why = walk_pair(sym, date, m, dte)
        if pair is None: res[name] = {"skip": why}; continue
        res[name] = {f"{sh}{'|D' if rc else ''}": settle(pair, m, sd, move, sh, rc) for sh in FILLS for rc in (False, True)}
    return sig, res


def entries_all():
    """The first alert of every day (not only expiry days), fair-list universe, within the chosen years."""
    ent = []
    for sym in P["universe"]:
        for i, date in enumerate(CAL):
            if date[:4] not in YEARS or not any(a <= date <= b for a, b in SPAN.values()) or i < 21: continue
            al = alerts_for(sym, date, CAL)
            if not al: continue
            m = next((q for q in range(zero5.FIRST, zero5.LAST + 1) if al[q]), None)
            if m is not None: ent.append((date, sym, m, al[m]))
    return ent


def table(rows_by_label):
    print("\n| rule | n | win | 2024 / 2025 / 2026 | wo5 | 1% | 4% |\n|---|---|---|---|---|---|---|")
    for lab, T in rows_by_label:
        mt = zero6.metrics(T)
        if not mt: print(f"| {lab} | 0 | | | | | |"); continue
        e4, dd4, _ = zero6.account_curve(sorted(T, key=lambda q: (q[0], q[1])), 0.04)
        py = mt["per_year"]
        print(f"| {lab} | {mt['n']} | {mt['win']}% | " + " / ".join(f"{py[y]:+,}" if py[y] is not None else "" for y in ("2024", "2025", "2026")) + f" | ${mt['wo5']:,} | ${mt['end1']:,} / {mt['dd1']}% | ${e4:,.0f} / {100 * dd4:.0f}% |")


def fair_filter(rows):
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    nf.features(rows)
    return [t for t in rows if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]


def direction():
    ent = zero5.entries()
    done = {}
    with mp.Pool(8) as pool:
        for sig, res in pool.imap_unordered(one_direction, [e[:3] for e in ent], chunksize=4): done["|".join(map(str, sig))] = res
    json.dump(done, open(f"{B}/z8_direction.json", "w"))
    rows = fair_filter([dict(date=k.split("|")[0], sym=k.split("|")[1], minute=int(k.split("|")[2]), right="C", res=v) for k, v in done.items() if v and "skip" not in v])
    print(f"\n## Which leg to drop: {len(rows)} 0DTE strangles, fair list, news filter; |t| at the fill: median {st.median(abs(t['res']['t0']) for t in rows if t['res']['t0'] is not None):.2f}, "
          f"|t| >= 1.8 on {sum(1 for t in rows if t['res']['t0'] is not None and abs(t['res']['t0']) >= 1.8)}")
    for sh in FILLS:
        print(f"\n### fill mid ± {int(sh * 100)}%")
        table([(f"{cn}{' + D bonus' if d else ''}", [(t["date"], t["minute"], t["res"][f"{sh}|{cn}{'|D' if d else ''}"]) for t in rows if isinstance(t["res"].get(f"{sh}|{cn}{'|D' if d else ''}"), float)]) for cn in CONFIRMS for d in (False, True)])


def dte():
    ent = entries_all()
    print(len(ent), "first-alerts on all days in", YEARS, flush=True)
    done = {}
    with mp.Pool(8) as pool:
        for i, (sig, res) in enumerate(pool.imap_unordered(one_dte, [e[:3] for e in ent], chunksize=4)):
            done["|".join(map(str, sig))] = res
            if i % 200 == 0: print(i, "/", len(ent), flush=True); json.dump(done, open(f"{B}/z8_dte.json", "w"))
    json.dump(done, open(f"{B}/z8_dte.json", "w"))
    rows = fair_filter([dict(date=k.split("|")[0], sym=k.split("|")[1], minute=int(k.split("|")[2]), right="C", res=v) for k, v in done.items() if v])
    for name in ("0dte", "dte1_7"):
        ok = [t for t in rows if isinstance(t["res"].get(name), dict) and "skip" not in t["res"][name]]
        reasons = collections.Counter(t["res"][name].get("skip") for t in rows if isinstance(t["res"].get(name), dict) and "skip" in t["res"][name])
        print(f"\n## {name}: {len(ok)} tradeable of {len(rows)} first-alerts on all days ({YEARS}); skipped {dict(reasons.most_common(4))}")
        table([(f"{name} fill {int(sh * 100)}%{' + D bonus' if d else ''}", [(t["date"], t["minute"], t["res"][name][f"{sh}{'|D' if d else ''}"]) for t in ok]) for sh in FILLS for d in (False, True)])
    both = [t for t in rows if all(isinstance(t["res"].get(n), dict) and "skip" not in t["res"][n] for n in ("0dte", "dte1_7"))]
    print(f"\n## the same {len(both)} expiry-day alerts, both expiries")
    table([(f"{n} fill 2%", [(t["date"], t["minute"], t["res"][n]["0.02"]) for t in both]) for n in ("0dte", "dte1_7")])


if __name__ == "__main__":
    {"direction": direction, "dte": dte}[sys.argv[1]]()
