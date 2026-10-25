"""Try a stock again after a stop (the user, 2026-10-25: "find a good strategy to try again a stock. we might go out but
the stock might still be strong so we might want to enter again. do tests on the fair list").

On the candidate 2.5 (sg_c12_15 entries, the rest-stop exits). A trade closed in full on its entry day by a stop (the
10 / 20-minute checks, -30%, the rest at -20%, the t-stat exit) may be bought again, once, at least 10 minutes after the
exit and by 14:30 New York (21:30 Israel), same side, a fresh 0.15-delta contract (the usual floor), the same size and
exits. The earlier tries (second_entry.py, rebuy.py, fail_rebuy2.py) re-entered on the trend alone and lost; the new
ingredient is evidence gathered after the exit. Set before running:
  R0  the entry rule again (volume >= 1.5x and t >= 1.8, or t >= 1.2 and D2 >= 1.5): the control, no new evidence
  R1  D2 measured only since the exit (the SPY-down minutes after the exit, up to the last 30) >= 1.5, with t >= 1.2 and
      volume >= 1.5x
  R2  R1 and the stock back past the first entry price our way (the stop's own condition reversed)
  R3  R1 with D2 >= 2.0
  R4  R1 only after a stop that was SPY's doing: the stock's excess move (stock - beta x SPY) from the entry to the exit
      no worse than -0.5 of its S30 unit
  R5  the stock makes a new high of the day our way (a new low for a put) with t >= 1.8 and volume >= 1.5x
Also: of the stopped trades, how many saw the first contract reach 2x its cost later that day (the ceiling).
Fair list, Feb 2024 - Oct 2026, from $100,000 at 1% and 2%, the 10% night cap.

  node --env-file=.env <dir>/run.mjs reentry.py      (from the repo root)
"""
import collections, csv, glob, math, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import news_filter as nf
import defence_signals as ds
from store import day
from signals import series, beta
from levels import ctx
from low_delta import HIS40, PRIOR
from score_sum import account

B = "data/local/x/bt"
CAL = eb.CAL
IDX = {d: i for i, d in enumerate(CAL)}
STOPS = {"U_check10", "U_check20", "U_out", "U_rest", "T_tstat"}
WAIT, LATEST = 10, 300
RULES = ("R0", "R1", "R2", "R3", "R4", "R5")
# the re-entry's own exits (second round, after all six lost with the usual exits: the re-entries were stopped out again,
# also on the stocks that ran): the usual; no stop of any kind for 30 minutes; only the -30% stop (no 10 / 20-minute
# checks, no rest stop, no t-stat exit) on the entry day
_X = eb.VERSIONS["d2-bonus"][2]
REX = {"usual": "d2-bonus", "no stop 30 min": "re-hold30", "-30% only": "re-stop30"}
eb.VERSIONS["re-hold30"] = ("re-entry, no stop 30 min", "sg_c12_15", {**_X, "hold_first": 30}, None)
eb.VERSIONS["re-stop30"] = ("re-entry, -30% only", "sg_c12_15", {**_X, "user_stop": {**_X["user_stop"], "checks": []}, "thesis": None, "after_half": None}, None)


def state(sym, date):
    """Per minute of the day: t, rv, the stock close, and the D2 contributions of each minute for a call and a put, and
    the excess move in S30 units (as defence_signals.stock)."""
    i = IDX[date]
    bars = day(sym, date); b_ = beta(sym, date, i, CAL); cx = ctx(sym, date)
    if not bars or b_ is None or not cx or not cx["sd"]: return None
    unit = cx["sd"]
    hist = []
    for d in CAL[i - 20:i]:
        v = [0] * 390
        for x in day(sym, d): v[x[0]] = x[5]
        acc, cum = 0, []
        for x in v: acc += x; cum.append(acc)
        if cum[-1] > 0: hist.append(cum)
    c = series(bars)[0]; spy = series(day("SPY", date))[0]
    vol = [0] * 390
    for x in bars: vol[x[0]] = x[5]
    cum, acc = [], 0
    for x in vol: acc += x; cum.append(acc)
    T, RV, EC, EP, XS = [None] * 390, [0.0] * 390, [0.0] * 390, [0.0] * 390, [0.0] * 390
    n = s1 = s2 = 0.0
    for m in range(1, 390):
        if c[m] and c[m - 1] and spy[m] and spy[m - 1]:
            rs = c[m] / c[m - 1] - 1; rp = spy[m] / spy[m - 1] - 1
            x = rs - b_ * rp
            n += 1; s1 += x; s2 += x * x
            XS[m] = x / unit
            if rp < 0: EC[m] = x / unit
            if rp > 0: EP[m] = -x / unit
        if m >= ds.FIRST and n >= ds.MIN_STEPS:
            mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
            T[m] = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
        med = sorted(h[m] for h in hist) if len(hist) >= 10 else []
        if med:
            k = len(med) // 2
            usual = med[k] if len(med) % 2 else (med[k - 1] + med[k]) / 2
            RV[m] = cum[m] / usual if usual else 0.0
    return dict(c=c, t=T, rv=RV, ec=EC, ep=EP, xs=XS)


def first_trades(job):
    """The candidate's trade -> (key, its row and fills) when a stop closed it in full on its entry day."""
    t = job
    r = eb.one(("d2-bonus", t))
    if not r: return None
    row, path = r
    steps = [(a, int(b), c, float(d), float(e), f) for a, b, c, d, e, f in (s.split(",") for s in path["steps"].split(";"))]
    sells = [s for s in steps if s[2] == "sell"]
    full_day = all(s[0] == t["date"] for s in sells) and not any(s[2] == "carry" for s in steps)
    if not full_day or sells[-1][5] not in STOPS: return ("kept", row)
    cost = float(path["cost"])
    later = [b[4] for b in day(row["contract"], t["date"]) if b[0] > sells[-1][1]]
    ran = bool(later) and max(later) >= 2 * cost
    return ("stopped", dict(row, exit_m=sells[-1][1], exit_rule=sells[-1][5], cost=cost, ran=ran, price=float(t["price"])))


def reentries(job):
    """A stopped trade -> {rule: the re-entry's row} for every rule that fires."""
    a = job
    S = state(a["sym"], a["date"])
    if not S: return a, {}
    bet = 1 if a["right"] == "C" else -1
    m0, mx = int(a["minute"]), a["exit_m"]
    con = S["ec"] if bet > 0 else S["ep"]
    excess = sum(S["xs"][m0 + 1:mx + 1]) * bet
    hi = max(S["c"][q] * bet for q in range(0, mx + 1) if S["c"][q])
    out = {}
    for m in range(mx + WAIT, LATEST + 1):
        t, rv, px = S["t"][m], S["rv"][m], S["c"][m]
        if t is None or px is None or rv < 1.5:
            if px: hi = max(hi, px * bet)
            continue
        tb = t * bet
        d2_day = sum(con[max(1, m - 29):m + 1])
        d2_new = sum(con[max(mx + 1, m - 29):m + 1])
        hit = {"R0": tb >= 1.8 or (tb >= 1.2 and d2_day >= 1.5),
               "R1": tb >= 1.2 and d2_new >= 1.5,
               "R3": tb >= 1.2 and d2_new >= 2.0,
               "R5": tb >= 1.8 and px * bet > hi}
        hit["R2"] = hit["R1"] and bet * (px - a["price"]) > 0
        hit["R4"] = hit["R1"] and excess >= -0.5
        hi = max(hi, px * bet)
        for rule in RULES:
            if rule in out or not hit[rule]: continue
            picked, why = sim.pick(a["sym"], a["date"], m, a["right"], px)
            if not picked: out[rule] = None; continue
            t2 = dict(date=a["date"], sym=a["sym"], right=a["right"], minute=str(m), time="", price=px, contract=picked[0], expiry=picked[1],
                      iv="", status="ok", c_t=str(round(tb, 2)))
            got = {}
            for xname, slug in REX.items():
                r = eb.one((slug, t2))
                if r: got[xname] = r[0]
            out[rule] = got or None
        if len(out) == len(RULES): break
    return a, out


def main():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
    with mp.Pool(6) as pool: F = [x for x in pool.map(first_trades, T, chunksize=8) if x]
    base = [r for _, r in F]
    stopped = [r for k, r in F if k == "stopped"]
    print(f"{len(base)} candidate trades; {len(stopped)} closed by a stop on the entry day; {sum(r['ran'] for r in stopped)} of them saw the first contract reach 2x its cost later that day")
    with mp.Pool(6) as pool: RE = pool.map(reentries, stopped, chunksize=2)
    pt = lambda x: 1e4 * max(-1, float(x))

    def show(name, rows):
        rows = sorted(rows, key=lambda r: (r["date"], int(r["minute"])))
        x = [dict(date=r["date"], pnl=str(pt(r["ret"]))) for r in rows]
        a1, d1 = account(x); a2, d2 = account([dict(date=r["date"], pnl=str(pt(r["ret_2pct"]))) for r in rows], 0.02)
        top = set(sorted(range(len(rows)), key=lambda i: -float(rows[i]["ret"]))[:5])
        a5, _ = account([y for i, y in enumerate(x) if i not in top])
        yr = " / ".join(f"{sum(pt(r['ret']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
        return f"| {name} | {len(rows)} | {sum(float(r['ret']) > 0 for r in rows)} | {yr} | ${a1:,.0f} / {d1:.0%} | ${a2:,.0f} / {d2:.0%} | ${a5:,.0f} |"

    for xname in REX:
      print(f"\n## Re-entry exits: {xname}")
      print("\n| Version | Trades | Winners | 2024 / 2025 / 2026 at $10K | At 1% / worst drop | At 2% / worst drop | Without the best 5 at 1% |\n|---|---|---|---|---|---|---|")
      print(show("candidate 2.5", base))
      for rule in RULES:
        add = [o[rule][xname] for _, o in RE if o.get(rule) and xname in o[rule]]
        print(show(f"2.5 + {rule}", base + add), flush=True)
      print("\n| Re-entries alone | Fired | No contract | Trades | Winners | Sum at $10K | Without their best 5 | Of the 'ran' trades re-entered | Best |\n|---|---|---|---|---|---|---|---|---|")
      for rule in RULES:
        fired = [(a, (o[rule] or {}).get(xname)) for a, o in RE if rule in o]
        tr = [(a, r) for a, r in fired if r]
        v = sorted((pt(r["ret"]) for _, r in tr), reverse=True)
        best = ", ".join(f"{r['sym']} {r['date'][2:]} {pt(r['ret']) / 1e3:+,.0f}K" for _, r in sorted(tr, key=lambda z: -float(z[1]["ret"]))[:3])
        print(f"| {rule} | {len(fired)} | {len(fired) - len(tr)} | {len(tr)} | {sum(x > 0 for x in v)} | {sum(v) / 1e3:+,.0f}K | {sum(v[5:]) / 1e3:+,.0f}K | {sum(a['ran'] for a, _ in tr)} | {best} |", flush=True)


if __name__ == "__main__":
    main()
