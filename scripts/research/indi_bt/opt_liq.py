"""Option liquidity screen, before any signal (the user, 2026-10-29: "I want more stockes with good spread and good io in
options", "also stock that know to move ... more than 3% at day", then "You need the hight oi and good spread filter
first").

Candidates: movers_syms.txt (2025 only: price >= $10, median day $ volume >= $200M, |daily move| >= 3% on >= 20% of
the days, not on the fair list or the Favorites, no funds; MRVL and XYZ out, just removed from the Favorites). For one
day a month of 2025 (the first trading day on or after the 10th), from Databento OPRA by the parent symbol (SYM.OPT):
  weekly    an expiry 1-7 days out exists
  oi        open interest (statistics, published before the open) of the OTM strikes within 15% of the day before's
            close in that nearest weekly expiry: the median per strike, calls and puts together
  spread    those strikes' book at 10:30 New York (cbbo-1m): (ask - bid) / mid, the median over strikes with a mid of
            $0.20 or more
Set before looking: pass = weekly on >= 10 of the 12 days, median oi >= 1,000 a strike, median spread <= 10%.
-> data/local/x/bt/opt_liq.json and a ranked table

  node --env-file=.env <dir>/run.mjs opt_liq.py      (from the app repo root; needs DATABENTO_API_KEY)
"""
import base64, csv, datetime as dt, http.client, io, json, os, sqlite3, statistics as st, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
NY = ZoneInfo("America/New_York")
AUTH = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
OUT = "data/local/x/bt/opt_liq.json"
SYMS = open(os.path.join(HERE, "movers_syms.txt")).read().strip().split(",")
WEEKLY_DAYS, MIN_OI, MAX_SPREAD = 10, 1000, 0.10


def get(params):
    data = urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", encoding="csv", pretty_px="true", pretty_ts="true", map_symbols="true", **params)).encode()
    req = urllib.request.Request("https://hist.databento.com/v0/timeseries.get_range", data=data, headers={"Authorization": AUTH})
    for tries in range(6):
        try: return list(csv.DictReader(io.StringIO(urllib.request.urlopen(req, timeout=300).read().decode())))
        except urllib.error.HTTPError as e:
            if e.code in (400, 422): return []
            if tries == 5: raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead):
            if tries == 5: raise
        time.sleep(10 * (tries + 1))


def utc(d, hh, mm):
    return dt.datetime(*map(int, d.split("-")), hh, mm, tzinfo=NY).astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M")


def parse(sym):
    """OCC 'MU    250117C00100000' -> (expiry, right, strike)."""
    s = sym.replace(" ", ""); occ = s[-15:]
    return f"20{occ[:2]}-{occ[2:4]}-{occ[4:6]}", occ[6], int(occ[7:]) / 1000


def one(job):
    sym, d, spot = job
    oi = get(dict(schema="statistics", stype_in="parent", symbols=f"{sym}.OPT", start=f"{d}T00:00", end=utc(d, 9, 30)))
    book = get(dict(schema="cbbo-1m", stype_in="parent", symbols=f"{sym}.OPT", start=utc(d, 10, 30), end=utc(d, 10, 31)))
    ois = {r["symbol"]: float(r["quantity"]) for r in oi if r.get("stat_type") == "9" and r.get("quantity")}
    day = dt.date.fromisoformat(d)
    exps = sorted({parse(s)[0] for s in ois} | {parse(r["symbol"])[0] for r in book})
    weekly = [e for e in exps if 1 <= (dt.date.fromisoformat(e) - day).days <= 7]
    if not weekly: return sym, d, dict(weekly=False)
    e0 = weekly[0]
    near = lambda s: (lambda e, r, k: e == e0 and ((r == "C" and spot <= k <= spot * 1.15) or (r == "P" and spot * 0.85 <= k <= spot)))(*parse(s))
    o = [v for s, v in ois.items() if near(s)]
    sp = []
    for r in book:
        if not near(r["symbol"]) or not r.get("bid_px_00") or not r.get("ask_px_00"): continue
        b, a = float(r["bid_px_00"]), float(r["ask_px_00"])
        mid = (a + b) / 2
        if b > 0 and mid >= 0.20: sp.append((a - b) / mid)
    return sym, d, dict(weekly=True, expiry=e0, strikes=len(o), oi=st.median(o) if o else 0, spread=st.median(sp) if sp else None, quotes=len(sp))


def main():
    con = sqlite3.connect("data/local/x/bt/daily_all.sqlite")
    days = sorted({r[0] for r in con.execute("SELECT DISTINCT date FROM d WHERE sym='SPY' AND date BETWEEN '2025-01-01' AND '2025-12-31'")})
    sample = [min(x for x in days if x[:7] == f"2025-{m:02d}" and x[8:] >= "10") for m in range(1, 13)]
    jobs = []
    for s in SYMS:
        for d in sample:
            prev = con.execute("SELECT c FROM d WHERE sym=? AND date<? ORDER BY date DESC LIMIT 1", (s, d)).fetchone()
            if prev: jobs.append((s, d, prev[0]))
    print(len(jobs), "stock-days", flush=True)
    part = OUT + ".part"   # each stock-day as it comes: a rerun after a dropped connection resumes
    res = json.load(open(part)) if os.path.exists(part) else {}
    jobs = [j for j in jobs if j[1] not in res.get(j[0], {})]
    print(len(jobs), "to fetch", flush=True)
    with ThreadPoolExecutor(6) as ex:
        for n, (s, d, r) in enumerate(ex.map(one, jobs)):
            res.setdefault(s, {})[d] = r
            if n % 50 == 0: json.dump(res, open(part, "w")); print(n, flush=True)
    json.dump(res, open(part, "w"))
    json.dump(res, open(OUT, "w"), indent=1)
    rows = []
    for s, by in res.items():
        w = [r for r in by.values() if r["weekly"]]
        oi = st.median([r["oi"] for r in w]) if w else 0
        spr = [r["spread"] for r in w if r.get("spread") is not None]
        spread = st.median(spr) if spr else None
        ok = len(w) >= WEEKLY_DAYS and oi >= MIN_OI and spread is not None and spread <= MAX_SPREAD
        rows.append((ok, oi, s, len(w), spread))
    rows.sort(key=lambda x: (not x[0], -x[1]))
    print(f"\n| Stock | Weekly (of 12 days) | Median OI a strike | Median spread | Pass |\n|---|---|---|---|---|")
    for ok, oi, s, w, spread in rows:
        print(f"| {s} | {w} | {oi:,.0f} | {'—' if spread is None else f'{spread:.1%}'} | {'yes' if ok else ''} |")
    keep = [s for ok, _, s, _, _ in rows if ok]
    open(os.path.join(HERE, "liquid_movers.txt"), "w").write(",".join(keep))
    print(f"\n{len(keep)} pass: {' '.join(keep)}")


if __name__ == "__main__":
    main()
