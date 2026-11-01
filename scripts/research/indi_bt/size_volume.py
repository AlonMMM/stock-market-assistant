"""Size by the volume at the signal instead of skipping (the user, 2026-11-01: "yes" to "half size under 2x, full size at
2x or more", after trend_entry.py found the >= 2x trades average about twice 2.9's trade on both halves and both lists
while the 1.5-2x trades still add up positive with their giants). spike_entry.py's setup (2.9's entries, picks and exits,
the pyramid, real quotes, the real price paid); every version is 2.9's trades with a size multiplier from the volume
since the open at the signal (c_rvol; the add rides on its main leg's multiplier). Set before running:
  base       2.9
  h175 / h20 / h25   half size when the volume is under 1.75 / 2.0 / 2.5x its usual, full size above
  h20-up     half size under 2.0x, 1.5x size at 2.0x or more
  flat75 / flat60    the yardstick: every trade at 0.75 / 0.6 of the size (a smaller flat size, the drop to beat)
  h20-up2 / up15 / up2   (second run, the user's "1.5 or 2X?") half under 2.0x and 2x above; full under and 1.5x / 2x above
Tune = even entry weeks, check = odd (split.py), in the same run; picked on tune by min(fair, Favorites) vs 2.9.

  node --env-file=.env <dir>/run.mjs size_volume.py      (from the app repo root)
-> data/local/x/bt/size_volume_summary.json
"""
import collections, json, math, multiprocessing as mp, os, statistics as st, sys
# 2.9's exits over the champion's (sim.walk lays BT_X over X): the f28 overlay + the break-even lock
os.environ["BT_X"] = json.dumps({"user_stop": {"checks": [], "out": -0.6}, "stock_stages": {"half": 0.5, "full": 1.0},
                                "late_hold": {"from": 330}, "be_lock": {"arm": 0.5, "update": True}})
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from levels import ctx
from score_sum import held as booked


def account(T, pct=0.01):
    """score_sum.account (marked, booked on the sale day) without its -1 cap on a row: a row here is already at most a
    whole loss of its own size, and a 1.5x row can lose 1.5 units."""
    import collections
    by = collections.defaultdict(list)
    for t in T: by[t["date"]].append(t)
    days = sorted(set(by) | {t.get("exit_day") or t["date"] for t in T})
    eq, peak, dd, open_, prev = 1e5, 1e5, 0.0, [], None
    for d in days:
        base = eq + sum(stake * (t.get("marks") or {}).get(prev, 0.0) for stake, t in open_)
        for t in by.get(d, []): open_.append((pct * base, t))
        keep = []
        for stake, t in open_:
            if (t.get("exit_day") or t["date"]) == d: eq += stake * float(t["pnl"]) / 1e4
            else: keep.append((stake, t))
        open_ = keep
        now = eq + sum(stake * (t.get("marks") or {}).get(d, 0.0) for stake, t in open_)
        peak = max(peak, now); dd = max(dd, 1 - now / peak); prev = d
    return eq + sum(stake * float(t["pnl"]) / 1e4 for stake, t in open_), dd
from split import half
from store import calendar

B = "data/local/x/bt"
CAL = calendar()
# name -> (measure, level): "run" = the 10-minute run, "spike" = the 3-minute one
SKIP = {}
# name -> (measure, level, minutes to wait, pullback)
PULL = {}
# name -> (measure, level, the turn off the dip's low in S30 or "hi" = back to the move's extreme, keep the signal's trade when no pullback)
RESUME = {}
TREND = []
# name -> size multiplier from the volume ratio at the signal
SIZEV = {"h175": lambda rv: 0.5 if rv < 1.75 else 1.0, "h20": lambda rv: 0.5 if rv < 2.0 else 1.0,
         "h25": lambda rv: 0.5 if rv < 2.5 else 1.0, "h20-up": lambda rv: 0.5 if rv < 2.0 else 1.5,
         "flat75": lambda rv: 0.75, "flat60": lambda rv: 0.6,
         # the user, 2026-11-01: "volume = 1.5 premia? or 2X?" (the boost on the >= 2x trades), added as a second run
         "h20-up2": lambda rv: 0.5 if rv < 2.0 else 2.0, "up15": lambda rv: 1.0 if rv < 2.0 else 1.5,
         "up2": lambda rv: 1.0 if rv < 2.0 else 2.0}
V = ["base", *SIZEV]


def trend_rules(t, m0, bet, cx, base, out):
    """The report's rules on one main signal; fills out["v"] / out["at"] for each TREND version that trades."""
    from store import day
    bars = {b[0]: b for b in day(t["sym"], t["date"])}
    B = [bars[m] for m in range(0, m0 + 1) if m in bars]
    # the volume gate needs no bars (fixed 2026-11-01: a 24-bar minimum used to skip every rule for the early signals)
    rv = float(t.get("c_rvol") or 0)
    if rv >= 2.0: out["v"]["rv20"] = base; out["at"]["rv20"] = m0
    if rv >= 3.0: out["v"]["rv30"] = base; out["at"]["rv30"] = m0
    if len(B) < 4 or not (cx and cx["sd"]):
        for v in ("conf3", "climax", "extveto"): out["v"][v] = base; out["at"][v] = m0
        return
    hi = lambda b: b[2] if bet > 0 else -b[3]
    # conf3: a buy-stop over the 3 bars up to the signal, live for the next 3 minutes
    level = max(hi(b) for b in B[-3:]) + 0.01 * (1 if bet > 0 else -1) * bet
    for m in range(m0 + 1, m0 + 4):
        b = bars.get(m)
        if b and hi(b) > level:
            px = cx["c"][m] or b[4]
            got = walk_at(t, m, px)
            if got: out["v"]["conf3"] = got; out["at"]["conf3"] = m
            break
    # VWAP and the 14-minute RSI up to the signal
    pv = sum((b[2] + b[3] + b[4]) / 3 * b[5] for b in B); vol = sum(b[5] for b in B)
    vwap = pv / vol if vol else B[-1][4]
    ch = [B[i][4] - B[i - 1][4] for i in range(max(1, len(B) - 14), len(B))]
    up = sum(x for x in ch if x > 0); dn = -sum(x for x in ch if x < 0)
    rsi = 100.0 if dn == 0 else 100 - 100 / (1 + up / dn)
    px0 = B[-1][4]
    ext = bet * math.log(px0 / vwap) / cx["sd"] if vwap > 0 else 0
    rsi_bet = rsi if bet > 0 else 100 - rsi
    if not (ext >= 2.5 or rsi_bet >= 85): out["v"]["extveto"] = base; out["at"]["extveto"] = m0
    # the climax: big bodies the bet's way, or a volume bar with a wick against the bet
    prev = B[-23:-3] or B[:1]
    body = sum(abs(b[4] - b[1]) for b in prev) / len(prev) or 1e-9
    avgv = sum(b[5] for b in prev) / len(prev) or 1e-9
    last3 = B[-3:]
    big = all(bet * (b[4] - b[1]) > 0 and abs(b[4] - b[1]) >= 2 * body for b in last3)
    def wick_against(b):
        rng = b[2] - b[3]
        if rng <= 0: return False
        w = (b[2] - max(b[1], b[4])) if bet > 0 else (min(b[1], b[4]) - b[3])
        return w >= 0.5 * rng
    vclimax = any(b[5] >= 3 * avgv and wick_against(b) for b in last3)
    if not (big or vclimax): out["v"]["climax"] = base; out["at"]["climax"] = m0; return
    dayhi = max(hi(b) for b in B)
    cvol, cpv = vol, pv
    for m in range(m0 + 1, min(m0 + 31, 375)):
        b = bars.get(m)
        if not b: continue
        cvol += b[5]; cpv += (b[2] + b[3] + b[4]) / 3 * b[5]
        if bet * (b[4] - cpv / cvol) < 0: break   # a close back through VWAP cancels
        if hi(b) > dayhi:
            got = walk_at(t, m, cx["c"][m] or b[4])
            if got: out["v"]["climax"] = got; out["at"]["climax"] = m
            break
SIZES = {0.02: ("r2", "r1"), 0.03: ("r3", "r15"), 0.01: ("r1", "r05")}
BUCKETS = [(-99, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.0), (2.0, 2.5), (2.5, 99)]


def walk_at(t, m, price):
    """The champion's pick and walk from minute m: {r1, r05, r2, r1, r3, r15, over, path} or None."""
    cands = cu.candidates(t["sym"], t["date"], m, t["right"], price)
    p = fe.choose(cands, 0.10 if t["sym"] == "IBIT" else 0.20, "none")
    if not p: return None
    c = p[0]
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    # every exit decided on the real price paid (BT_BASIS=real, the 2.9 audit): walk again from it
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], m, t["right"], c[0], c[1], CAL, paid=rcost)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    row = dict(r1=sim.result(rcost, real, 0.01), r05=sim.result(rcost, real, 0.005), r2=sim.result(rcost, real, 0.02),
               r3=sim.result(rcost, real, 0.03), r15=sim.result(rcost, real, 0.015), over=int(any(s[2] == "carry" for s in steps)),
               h=booked(rcost, real))
    early = [s for s in steps if s[2] == "sell" and s[0] == t["date"] and s[1] <= m + 20]
    sold = sum(s[3] for s in early)
    path = "full at 20"
    if sold >= 0.999: path = "out by 20"
    elif early and all(s[5] == "U_check10" for s in early): path = "half at 10, held at 20"
    elif early: path = "other"
    row["path"] = path
    sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
    row["held"] = {}
    for mm in range(m, 390):
        k = RB.quote(c[0], t["date"], mm)
        row["held"][mm] = (1 - sum(s[3] for s in sells if s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    return row


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    bet = 1 if t["right"] == "C" else -1
    cx = ctx(t["sym"], t["date"])
    run = spike = None
    if cx and cx["sd"] and m0 >= 10 and cx["c"][m0] and cx["c"][m0 - 10]:
        run = bet * math.log(cx["c"][m0] / cx["c"][m0 - 10]) / cx["sd"]
    if cx and cx["sd"] and m0 >= 3 and cx["c"][m0] and cx["c"][m0 - 3]:
        spike = bet * math.log(cx["c"][m0] / cx["c"][m0 - 3]) / cx["sd"]
    size = {"run": run, "spike": spike}
    out = dict(src=src, kind=kind, date=t["date"], minute=m0, sym=t["sym"], right=t["right"], run=run,
               d2=int(float(t.get("c_t") or 9) < 1.8), v={}, at={})
    base = walk_at(t, m0, float(t["price"]))
    if base is None: return None
    out["v"]["base"] = base; out["at"]["base"] = m0
    if kind == "add":
        for v in V[1:]: out["v"][v] = base; out["at"][v] = m0
        return out
    out["spike"] = spike
    for v, (what, k) in SKIP.items():
        if size[what] is None or size[what] < k: out["v"][v] = base; out["at"][v] = m0
    out["rvol"] = float(t.get("c_rvol") or 0)
    for v in SIZEV: out["v"][v] = base; out["at"][v] = m0
    for v, (what, k, res, keep) in RESUME.items():
        if size[what] is None or size[what] < k: out["v"][v] = base; out["at"][v] = m0; continue
        best, low, mlow = cx["c"][m0], None, None
        for m in range(m0 + 1, min(m0 + 16, 375)):
            px = cx["c"][m]
            if px is None: continue
            best = max(best, px) if bet > 0 else min(best, px)
            if bet * math.log(px / best) <= -0.25 * cx["sd"]: low, mlow = px, m; break
        if mlow is None:
            if keep: out["v"][v] = base; out["at"][v] = m0
            continue
        for m in range(mlow + 1, min(mlow + 31, 375)):
            px = cx["c"][m]
            if px is None: continue
            low = min(low, px) if bet > 0 else max(low, px)
            turned = bet * math.log(px / best) >= 0 if res == "hi" else bet * math.log(px / low) >= res * cx["sd"]
            if turned:
                got = walk_at(t, m, px)
                if got: out["v"][v] = got; out["at"][v] = m
                break
    for v, (what, k, wait, pull) in PULL.items():
        if size[what] is None or size[what] < k: out["v"][v] = base; out["at"][v] = m0; continue
        # the move's extreme since the signal; a pullback of `pull` typical moves from it within `wait` minutes
        best = cx["c"][m0]
        for m in range(m0 + 1, min(m0 + wait + 1, 375)):
            px = cx["c"][m]
            if px is None: continue
            best = max(best, px) if bet > 0 else min(best, px)
            if bet * math.log(px / best) <= -pull * cx["sd"]:
                got = walk_at(t, m, px)
                if got: out["v"][v] = got; out["at"][v] = m
                break
    return out


def entries(R, adds, src, v, part, size, a=""):
    full, halfk = SIZES[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or v not in r["v"]: continue
        x, m = r["v"][v], r["at"][v]
        w = SIZEV[v](r.get("rvol", 0)) if v in SIZEV else 1.0
        E.append((r["date"], m, w, x[full], x["over"], x["h"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= m or v not in ad["v"]: continue
            share, up = x["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5 * w, ad["v"][v][halfk], ad["v"][v]["over"], ad["v"][v]["h"]))
            break
    return E


def stats(E, size):
    R = sorted(E, key=lambda e: e[:5])
    usd = [1e4 * e[2] * max(-1, e[3]) for e in R]
    # booked on the sale day; an add's marks at its half size
    pnl = [dict(date=e[0], pnl=str(u), exit_day=e[5]["exit_day"], marks={d: e[2] * v for d, v in e[5]["marks"].items()})
           for e, u in zip(R, usd)]
    acct, dd = account(pnl, size)
    top = sorted(range(len(R)), key=lambda i: -usd[i])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in set(top[:5])], size)
    giants = {i for i in range(len(R)) if R[i][3] >= 3.0}
    years = collections.defaultdict(float)
    for e, u in zip(R, usd): years[e[0][:4]] += u
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), win=round(sum(e[3] > 0 for e in R) / max(1, len(R)), 3),
                per=round(sum(usd) / max(1, len(R))), median=round(st.median(usd)) if usd else 0,
                nongiant=round(sum(u for i, u in enumerate(usd) if i not in giants)), giants=len(giants),
                best5=round(sum(usd[i] for i in top[:5])), years={y: round(x) for y, x in sorted(years.items())})


def group(rows):
    """Count, giants, median, sum, sum without the giants, by year: main legs at $10K."""
    usd = [1e4 * max(-1, r["v"]["base"]["r1"]) for r in rows]
    g = [u for r, u in zip(rows, usd) if r["v"]["base"]["r1"] >= 3.0]
    years = collections.defaultdict(float)
    for r, u in zip(rows, usd): years[r["date"][:4]] += u
    return dict(n=len(rows), giants=len(g), median=round(st.median(usd)) if usd else 0, sum=round(sum(usd)),
                nongiant=round(sum(usd) - sum(g)), years={y: round(x) for y, x in sorted(years.items())})


def table(R, adds, part, out, title):
    for size in SIZES:
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for v in V:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = stats(entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)
    print(f"\n{title}: the trades each version removed or moved (main legs, at $10K: the champion's result on them)\n")
    print("| Version | Fair: trades · their sum · without their giants · giants · median | Favorites: the same |\n|---|---|---|")
    for v in V[1:]:
        cells = []
        for src, a in (("fair", ""), ("fav", FR.A24)):
            hit = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a
                   and (v not in r["v"] or r["at"][v] != r["minute"])]
            g = group(hit); out[f"{part}|{v}|{src}|removed"] = g
            cells.append(f"{g['n']} · {g['sum']:+,} · {g['nongiant']:+,} · {g['giants']} · {g['median']:+,}")
        print(f"| {v} | {cells[0]} | {cells[1]} |", flush=True)


def diagnostics(R, part, out):
    for name, key in (("the first 20 minutes", lambda r: r["v"]["base"]["path"]),
                      ("the run before the signal (typical 30-minute moves)", lambda r: next((f"{a:g} to {b:g}".replace("-99 to", "under").replace(" to 99", " or more")
                                                                                         for a, b in BUCKETS if r["run"] is not None and a <= r["run"] < b), "unknown"))):
        print(f"\n#### Diagnostic, {part} weeks: the champion's trades by {name}\n")
        print("| Group | List | Trades | Giants | Median | Sum | Without the giants | By year |\n|---|---|---|---|---|---|---|---|")
        for src, a in (("fair", ""), ("fav", FR.A24)):
            rows = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part and r["date"] >= a]
            by = collections.defaultdict(list)
            for r in rows: by[key(r)].append(r)
            for k in sorted(by):
                g = group(by[k]); out[f"diag|{part}|{name[:12]}|{src}|{k}"] = g
                yrs = " · ".join(f"{y} {x:+,}" for y, x in g["years"].items())
                print(f"| {k} | {src} | {g['n']} | {g['giants']} | {g['median']:+,} | {g['sum']:+,} | {g['nongiant']:+,} | {yrs} |", flush=True)


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {}
    table(R, adds, "tune", out, "Tune weeks (even)")
    base = lambda src: out[f"tune|base|{src}|0.01"]["acct"]
    score = lambda v: min(out[f"tune|{v}|fair|0.01"]["acct"] / base("fair"), out[f"tune|{v}|fav|0.01"]["acct"] / base("fav"))
    best = max(V[1:], key=score)
    out["best"] = best
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs the champion, 1%): {best} ({score(best):.3f}); better on both: {score(best) > 1}")
    table(R, adds, "check", out, "Check weeks (odd), the same run")
    for part in ("tune", "check"): diagnostics(R, part, out)
    json.dump(out, open(f"{B}/size_volume_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
