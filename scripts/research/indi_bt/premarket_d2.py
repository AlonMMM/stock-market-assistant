"""The D2 bonus before the open (the user, 2026-10-25: "the 10 minutes of the opening: if we have D2 bonus + more than 1.2
in the spy - bet with no stop on the opening"; then: pre market, strength t >= 1.2, no stop for 30 minutes).

On the candidate (2.5). From the pre-market 1-minute bars of the stock and SPY, 08:00-09:29 New York:
  t     the t-stat of the stock's 1-minute excess moves (stock - beta x SPY; beta of the 20 sessions before) over the
        pre-market minutes where both traded (10 steps at least), as the regular signal's t
  D2    the excess move summed over the SPY-down minutes of the last 30 pre-market minutes (09:00-09:29), in the stock's
        S30 unit (the SPY-up minutes for a put), as defence_signals.py
  volume  pre-market volume >= 1.5x its median of the 20 sessions before (under 4x: the news filter), no earnings
        reaction day
A call when t >= 1.2 and D2 >= the level, a put on the mirror. The option is picked at 09:35 (the first five minutes'
volume against the 200-contract floor; the market's options open at 09:30) and bought on the next bar; then the
candidate's exits with no stop of any kind for the first 30 minutes (sim.py hold_first). That stock-day's regular
entry, if any, is replaced by this one. Variants, set before running:
  pm30      D2 >= 1.5, no stop for 30 minutes (the thesis)
  pm0       D2 >= 1.5, the usual stops (does the no-stop part matter?)
  pm30-d20  D2 >= 2.0, no stop for 30 minutes (a stricter D2)
Fair list, Feb 2024 - Oct 2026, 1% / 2% from $100,000 with the 10% overnight cap.

  node --env-file=.env <dir>/run.mjs premarket_d2.py [fetch|run]      (from the repo root)
"""
import collections, csv, datetime as dt, glob, json, math, multiprocessing as mp, os, statistics as stt, sys, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import news_filter as nf
from store import db, _get, NY, calendar, day
from signals import beta
from levels import ctx
from low_delta import HIS40, PRIOR
from score_sum import account, held

B = "data/local/x/bt"
CAL = calendar()
IDX = {d: i for i, d in enumerate(CAL)}
A, Z = "2024-02-01", "2026-10-23"
PRE0, PREN = 8 * 60, 90  # 08:00 New York, 90 minutes to 09:30
PICK_MIN = 5  # 09:35
db.execute("CREATE TABLE IF NOT EXISTS prem (symbol TEXT, date TEXT, bars TEXT, PRIMARY KEY (symbol, date))")


def fetch():
    """Pre-market 1-minute bars 08:00-09:29 New York, per symbol and day -> table prem ([minute from 08:00, o, h, l, c, v])."""
    syms = sorted(HIS40 | {"SPY"})
    d = dt.date.fromisoformat(A) - dt.timedelta(days=40)
    while d.isoformat() <= Z:
        e = min((d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1), dt.date.fromisoformat(Z))
        for i in range(0, len(syms), 20):
            part = syms[i:i + 20]
            key = f"prem|{','.join(part)}|{d}|{e}"
            if db.execute("SELECT 1 FROM done WHERE key=?", (key,)).fetchone(): continue
            got, token = collections.defaultdict(list), None
            while True:
                q = dict(symbols=",".join(part), timeframe="1Min", start=f"{d}T11:00:00Z", end=f"{e}T14:30:00Z", limit=10000, sort="asc", feed="sip", adjustment="raw")
                if token: q["page_token"] = token
                j = _get("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(q))
                for s, bs in (j.get("bars") or {}).items():
                    for b in bs:
                        t = dt.datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(NY)
                        m = t.hour * 60 + t.minute - PRE0
                        if 0 <= m < PREN: got[(s, t.date().isoformat())].append([m, b["o"], b["h"], b["l"], b["c"], b["v"]])
                token = j.get("next_page_token")
                if not token: break
            for (s, dd), v in got.items(): db.execute("INSERT OR REPLACE INTO prem VALUES (?,?,?)", (s, dd, json.dumps(v)))
            db.execute("INSERT OR REPLACE INTO done VALUES (?)", (key,)); db.commit()
        print("fetched", d, e, flush=True)
        d = e + dt.timedelta(days=1)


def prem(sym, date):
    r = db.execute("SELECT bars FROM prem WHERE symbol=? AND date=?", (sym, date)).fetchone()
    c = [None] * PREN
    for b in json.loads(r[0]) if r else []: c[b[0]] = b[4]
    return c


def signal(job):
    """-> the stock-day's pre-market state: t, D2 for a call and a put, the volume ratio; None when not computable."""
    sym, date = job
    i = IDX[date]
    b_ = beta(sym, date, i, CAL); cx = ctx(sym, date)
    if b_ is None or not cx or not cx["sd"]: return None
    c, spy = prem(sym, date), prem("SPY", date)
    n = s1 = s2 = 0.0; dc = dp = 0.0
    for m in range(1, PREN):
        if None in (c[m], c[m - 1], spy[m], spy[m - 1]): continue
        rs = c[m] / c[m - 1] - 1; rp = spy[m] / spy[m - 1] - 1
        x = rs - b_ * rp
        n += 1; s1 += x; s2 += x * x
        if m >= PREN - 30:
            if rp < 0: dc += x / cx["sd"]
            if rp > 0: dp += -x / cx["sd"]
    if n < 10: return None
    mu = s1 / n; var = max(s2 / n - mu * mu, 0.0)
    t = mu / math.sqrt(var) * math.sqrt(n) if var > 0 else 0.0
    vols = [r[0] for r in db.execute("SELECT vol FROM pre WHERE symbol=? AND date IN (%s)" % ",".join("?" * 20), (sym, *CAL[i - 20:i])).fetchall() if r[0]]
    v = db.execute("SELECT vol FROM pre WHERE symbol=? AND date=?", (sym, date)).fetchone()
    rv = v[0] / stt.median(vols) if v and v[0] and len(vols) >= 10 else 0.0
    return dict(sym=sym, date=date, t=round(t, 2), d2c=round(dc, 2), d2p=round(dp, 2), rv=round(rv, 2), steps=int(n))


def trade(job):
    """A pre-market entry -> its contract at 09:35 and the walk under the version's exits."""
    slug, s, side = job
    bars = day(s["sym"], s["date"])
    px = next((b[4] for b in bars if b[0] <= PICK_MIN and b[0] >= PICK_MIN - 3), None) if bars else None
    if px is None: return None
    picked, why = sim.pick(s["sym"], s["date"], PICK_MIN, side, px)
    if not picked: return slug, s, side, None, why
    t = dict(date=s["date"], sym=s["sym"], right=side, minute=str(PICK_MIN), time="09:35", price=px, contract=picked[0], expiry=picked[1],
             iv=round(picked[6], 3) if picked[6] else "", status="ok", c_t=str(s["t"]))
    r = eb.one((slug, t))
    return slug, s, side, r, None


VARIANTS = {"pm30": (1.5, 30), "pm0": (1.5, 0), "pm30-d20": (2.0, 30)}
for _slug, (_lvl, _hold) in VARIANTS.items():  # at import, so the pool's workers know them too
    eb.VERSIONS[_slug] = (f"2.5 + pre-market D2 >= {_lvl} at the open, no stop {_hold} min", "sg_c12_15", {**eb.CHAMP, "hold_first": _hold}, None)


def run():
    days = [(s, d) for d in CAL if A <= d <= Z for s in sorted(HIS40) if s in PRIOR[d[:4]]]
    with mp.Pool(6) as pool: S = [x for x in pool.map(signal, days, chunksize=40) if x]
    for s in S: s["right"] = "C"  # news_filter.features reads a side (for the gap only)
    nf.features(S)
    S = [s for s in S if s["e_next"] != 0 and 1.5 <= s["rv"] < 4]
    print(f"{len(days)} stock-days, {len(S)} with pre-market volume 1.5-4x and no earnings reaction", flush=True)
    jobs = []
    for slug, (lvl, _) in VARIANTS.items():
        for s in S:
            if s["t"] >= 1.2 and s["d2c"] >= lvl: jobs.append((slug, s, "C"))
            elif -s["t"] >= 1.2 and s["d2p"] >= lvl: jobs.append((slug, s, "P"))
    with mp.Pool(6) as pool: R = pool.map(trade, jobs, chunksize=4)
    # the candidate and production, walked by export_bench as on the dashboard
    base = []
    for prefix, slug in (("sg_c12_15", "d2-bonus"), ("s_t18r15", "bot24")):
        T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
        nf.features(T)
        base += [(slug, t) for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]
    with mp.Pool(6) as pool: BR = [r for r in pool.map(eb.one, base, chunksize=8) if r]
    rows = [r[0] for r in BR]
    H = {r[0]["key"]: held(r[1]["cost"], r[1]["steps"]) for r in BR + [x[3] for x in R if x and x[3]]}
    cand = [r for r in rows if r["version"] == "d2-bonus"]
    pm = collections.defaultdict(list); why = collections.Counter()
    for slug, s, side, r, w in [x for x in R if x]:
        if r: pm[slug].append(r[0])
        elif slug == "pm30": why[w] += 1
    print("pm30 signals without a trade:", dict(why))
    versions = {"bot24": [r for r in rows if r["version"] == "bot24"], "d2-bonus": cand}
    for slug in VARIANTS:
        taken = {(r["date"], r["sym"]) for r in pm[slug]}
        versions[slug] = sorted([r for r in cand if (r["date"], r["sym"]) not in taken] + pm[slug], key=lambda r: (r["date"], int(r["minute"])))
        versions[slug + " (pre-market trades only)"] = pm[slug]
    pt = lambda x: 1e4 * max(-1, float(x))
    print("\n| Version | Trades | Winners | Per trade at $10K | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Best 5 |\n|---|---|---|---|---|---|---|---|---|")
    for slug, T in versions.items():
        if not T: print(f"| {slug} | 0 |"); continue
        T = sorted(T, key=lambda r: (r["date"], int(r["minute"])))
        x = [dict(date=r["date"], pnl=str(pt(r["ret"])), **H[r["key"]]) for r in T]
        a1, d1 = account(x); a2, d2 = account([dict(date=r["date"], pnl=str(pt(r["ret_2pct"])), **H[r["key"]]) for r in T], 0.02)
        top = sorted(range(len(T)), key=lambda i: -float(T[i]["ret"]))[:5]
        a5, _ = account([y for i, y in enumerate(x) if i not in set(top)])
        yr = " / ".join(f"{sum(pt(r['ret']) for r in T if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
        best = ", ".join(f"{T[i]['sym']} {T[i]['date'][2:]} {pt(T[i]['ret']) / 1e3:+,.0f}K" for i in top)
        print(f"| {slug} | {len(T)} | {sum(float(r['ret']) > 0 for r in T)} | {sum(pt(r['ret']) for r in T) / len(T):+,.0f} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {best} |", flush=True)
    for slug in VARIANTS:
        ex = collections.Counter(r["exit"] for r in pm[slug])
        print(f"\n{slug}: exits {ex.most_common(6)}")
    out = f"{B}/premarket_d2"
    os.makedirs(out, exist_ok=True)
    pm_rows = [(r, p) for x in R if x and x[3] for r, p in [x[3]]]
    with open(f"{out}/pm_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(pm_rows[0][0])); w.writeheader(); w.writerows(r for r, _ in pm_rows)
    with open(f"{out}/pm_paths.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(pm_rows[0][1])); w.writeheader(); w.writerows(p for _, p in pm_rows)
    print("pre-market trades and fills ->", out)


if __name__ == "__main__":
    {"fetch": fetch, "run": run}[(sys.argv[1:] or ["run"])[0]]()
