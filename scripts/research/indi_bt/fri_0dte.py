"""A Friday 0DTE leg with the Volume bot's exits (the user, 2026-11-04: "On friday we can try to add 0dte. But this should
be with different strategy - aomthing similar to the volume exits", then "Go" on the plan). Built on 2.10 (sale_limit.py
bid-c5 = size_volume.py t3A-c5: its entries, picks, exits, sizing and pyramid, real quotes, the real price paid).

Every 2.10 main signal on a Friday before 13:00 New York (minute <= 209, the Volume bot's lastMinute) also buys a leg of
today's expiry, ON TOP of 2.10's own trade: the 0.20-delta OTM strike, $0.20 and 200 contracts in 30 minutes, else the
nearest liquid strike toward the money up to delta 0.35 (the Volume bot's pick with the liquid fallback). Bought on the
book as the signal minute closes (opt_spread.price "bid": mid + half the spread, chasing the ask), sold at the bid.
Its size = 2.10's step x the volume tier of the signal, within 5% of the account with its main leg and the main's add.
Exits, set before running (the stock's give-back is Volume 1.2.0's: 0.75 of the stock's typical 30-minute move off its
best close since the buy, on minute closes; the broker's -80% stop on the bid at any minute; all out by 15:50):
  z-vol     grace 30 minutes (only the stop sells in it), as Volume 1.2.0
  z-g15     grace 15 minutes
  z-trail   z-vol + once the bid is 3x the price paid, out 30% under its highest bid
Tune = even weeks, check = odd (split.py), the same run; picked on tune by min(fair, Favorites) vs 2.10 at 2%; only the
pick is shown on check, with 2.10.

  Z_PASS=list node --env-file=.env <dir>/run.mjs fri_0dte.py   (the contracts with no book -> open37_dbx_list.csv + the cost)
  dbx_fetch.py open37                                            (buys them)
  node --env-file=.env <dir>/run.mjs fri_0dte.py                 (from the app repo root)
-> data/local/x/bt/fri_0dte_summary.json
"""
import base64, collections, csv, datetime as dt, json, multiprocessing as mp, os, statistics as st, sys, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sale_limit as SL
SL.MODES = ("bid-c5",)
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
import size_volume as SV
from levels import ctx
from split import half
from store import day

B = "data/local/x/bt"
LISTING = os.environ.get("Z_PASS") == "list"
LAST_MINUTE, END, GIVE, STOP, TARGET, MAXD = 209, 380, 0.75, -0.8, 0.20, 0.35
ZV = {"z-vol": dict(grace=30), "z-g15": dict(grace=15), "z-trail": dict(grace=30, arm=3.0, trail=0.3)}
BASE = "bid-c5"


def expiry_today(sym, date):
    m0 = date[:7] + "-01"
    k = (sym, date[:7])
    if k not in sim._exp: sim._exp[k] = sim.expiries(sym, m0, (dt.date.fromisoformat(m0) + dt.timedelta(days=40)).isoformat())
    return date if date in sim._exp[k] else None


def prefetch(sym, date, right, price):
    call = right == "C"
    ks = [k for k in sim.chain(sym, date, right) if (price <= k <= price * (1 + sim.C["otm_scan_max"]) if call else price * (1 - sim.C["otm_scan_max"]) <= k <= price)]
    ks = sorted(ks, key=lambda k: abs(k - price))[:sim.C["max_strikes"]]
    syms = [sim.occ(sym, date, k, right) for k in ks]
    if syms:
        try: sim.fetch_bars("options", syms, date, date, key=f"z0|{sym}|{date}|{right}")
        except Exception: pass


def pick(t, m):
    """The Volume bot's pick on today's expiry -> candidate (symbol, expiry, strike, delta, price, vol30, iv) or None."""
    sym, date, right, px = t["sym"], t["date"], t["right"], float(t["price"])
    if not expiry_today(sym, date): return None
    prefetch(sym, date, right, px)
    keep = sim.expiry_for
    sim.expiry_for = lambda und, d: date
    try: cands = cu.candidates(sym, date, m, right, px)
    finally: sim.expiry_for = keep
    if not cands: return None
    best = min(cands, key=lambda c: abs(abs(c[3]) - TARGET))
    if best[4] >= 0.20 and best[5] >= 200: return best
    ok = [c for c in cands if c[4] >= 0.20 and c[5] >= 200 and abs(best[3]) <= abs(c[3]) <= MAXD]
    return min(ok, key=lambda c: abs(c[3])) if ok else None


def walk(t, m, c, u, grace, arm=None, trail=None):
    """The 0DTE leg from the signal minute m -> (real cost, steps, exit rule) or None (no book at the buy)."""
    sym, date, right = t["sym"], t["date"], t["right"]
    sb = {b[0]: b[4] for b in day(sym, date)}
    if m not in sb: return None
    k = RB.quote(c[0], date, m)
    if not k: return None
    buy = [(date, m + 1, "buy", 1.0, (k[0] + k[1]) / 2, "entry")]
    paid, _ = OS.price(buy, c[0], (k[0] + k[1]) / 2, "bid")
    best, hi_bid, rule, at = sb[m], 0.0, "end", END
    for j in range(m + 1, END + 1):
        q = RB.quote(c[0], date, j)
        if q and q[0] <= paid * (1 + STOP): rule, at = "stop80", j; break
        if q: hi_bid = max(hi_bid, q[0])
        if arm and hi_bid >= arm * paid and q and q[0] <= hi_bid * (1 - trail): rule, at = "trail", j; break
        s = sb.get(j)
        if s is None: continue
        best = max(best, s) if right == "C" else min(best, s)
        if j - m <= grace: continue
        back = 1 - s / best if right == "C" else s / best - 1
        if back >= GIVE * u: rule, at = "giveback", j; break
    steps = buy + [(date, min(at + 1, 390), "sell", 1.0, 0.0, rule)]
    rcost, real = OS.price(steps, c[0], paid, "bid")
    if real[-1][4] == 0.0: return None   # no book at the sale
    return rcost, real, rule


def zero(t, m):
    c = pick(t, m)
    if not c: return None
    if LISTING: return dict(want=(t["date"], c[0], max(m - 2, 0)), have=bool(RB.book(t["date"]).get(c[0])))
    x = ctx(t["sym"], t["date"])
    if not x or not x.get("sd"): return None
    out = dict(contract=c[0], delta=round(abs(c[3]), 3), v={})
    for v, p in ZV.items():
        g = walk(t, m, c, x["sd"], **p)
        if not g: continue
        rcost, real, rule = g
        out["v"][v] = dict(ret=sim.result(rcost, real, 0), rule=rule, paid=round(rcost, 4), sold=real[-1][4], exit_min=real[-1][1])
    return out


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    m0 = int(t["minute"])
    friday = dt.date.fromisoformat(t["date"]).weekday() == 4 and kind == "main" and m0 <= LAST_MINUTE
    if LISTING:
        z = zero(t, m0) if friday else None
        return dict(src=src, z=z) if z else None
    r = SL.one(job)
    if r is None: return None
    r.pop("log", None)
    if friday: r["z"] = zero(t, m0)
    return r


def entries(R, adds, src, v, part, size, a=""):
    """size_volume.entries (2.10) + the 0DTE leg of version v at the main leg's tier, within 5% with the main and its add."""
    full, halfk = SV.SIZES[size]
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a or BASE not in r["v"]: continue
        x, m = r["v"][BASE], r["at"][BASE]
        w = SV.SIZEV[BASE](r.get("rvol", 0))
        E.append((r["date"], m, w, x[full], x["over"], x["h"]))
        used = w
        if r["d2"]:
            for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
                if ad["minute"] <= m or BASE not in ad["v"]: continue
                share, up = x["held"].get(ad["minute"], (0, None))
                aw = min(0.5 * w, max(0.0, 0.05 / size - w))
                if share > 0 and up is not None and up > 0 and aw > 0:
                    E.append((ad["date"], ad["minute"], aw, ad["v"][BASE][halfk], ad["v"][BASE]["over"], ad["v"][BASE]["h"])); used += aw
                break
        z = (r.get("z") or {}).get("v", {}).get(v)
        if z:
            zw = min(w, max(0.0, 0.05 / size - used))
            if zw > 0: E.append((r["date"], m, zw, z["ret"], 0, dict(exit_day=r["date"], marks={})))
    return E


def legs(R, src, part, v, a=""):
    """The 0DTE legs alone, at $10K each: count, winners, median, giants (+300%), sum, sum without giants, by year, exits."""
    Z = [(r["date"], r["z"]["v"][v]) for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part
         and r["date"] >= a and (r.get("z") or {}).get("v", {}).get(v)]
    usd = [1e4 * max(-1, z["ret"]) for _, z in Z]
    g = [u for u in usd if u >= 3e4]
    yrs = collections.defaultdict(float)
    for (d, _), u in zip(Z, usd): yrs[d[:4]] += u
    return dict(n=len(Z), win=sum(u > 0 for u in usd) / max(1, len(usd)), median=round(st.median(usd)) if usd else 0,
                giants=len(g), sum=round(sum(usd)), rest=round(sum(usd) - sum(g)), years={y: round(x) for y, x in sorted(yrs.items())},
                exits=dict(collections.Counter(z["rule"] for _, z in Z)))


def table(R, adds, part, versions, out, title):
    for size in (0.02, 0.03):
        print(f"\n### {title}, real quotes, {size:.0%} a trade from $100,000\n")
        print("| Version | List | Trades | Winners | Per trade at $10K | Median | End / worst drop | vs 2.10 | Without the best 5 | Best 5 | Giants · non-giant sum | By year |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v in versions:
            for src, a in (("fair", ""), ("fav", FR.A24)):
                s = SV.stats(entries(R, adds, src, v, part, size, a), size)
                out[f"{part}|{v}|{src}|{size}"] = s
                b = out.get(f"{part}|2.10|{src}|{size}", s)["acct"]
                yrs = " · ".join(f"{y} {x:+,}" for y, x in s["years"].items())
                print(f"| {v} | {src} | {s['trades']} | {s['win']:.0%} | {s['per']:+,} | {s['median']:+,} | ${s['acct']:,} / {s['dd']:.0%} | {s['acct'] / b:.3f} | ${s['no5']:,} | {s['best5']:+,} | {s['giants']} · {s['nongiant']:+,} | {yrs} |", flush=True)
    print(f"\n#### {title}: the 0DTE legs alone, at $10K each\n")
    print("| Version | List | Legs | Winners | Median | Giants | Sum | Without giants | By year | Exits |\n|---|---|---|---|---|---|---|---|---|---|")
    for v in versions:
        if v == "2.10": continue
        for src, a in (("fair", ""), ("fav", FR.A24)):
            g = legs(R, src, part, v, a); out[f"{part}|{v}|{src}|legs"] = g
            yrs = " · ".join(f"{y} {x:+,}" for y, x in g["years"].items())
            ex = ", ".join(f"{k} {n}" for k, n in sorted(g["exits"].items(), key=lambda kv: -kv[1]))
            print(f"| {v} | {src} | {g['n']} | {g['win']:.0%} | {g['median']:+,} | {g['giants']} | {g['sum']:+,} | {g['rest']:+,} | {yrs} | {ex} |", flush=True)


def cost(rows):
    """Databento's price for the list (metadata.get_cost: free, nothing bought)."""
    auth = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
    from dbx_fetch import pad, utc
    by = collections.defaultdict(set); first = {}
    for d, c, m in rows: by[d].add(c); first[d] = min(first.get(d, 999), m)
    total = 0.0
    for d in sorted(by):
        q = urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", schema="cbbo-1m", stype_in="raw_symbol",
                                        symbols=",".join(pad(s) for s in sorted(by[d])), start=utc(d, first[d] - 1), end=utc(d, 391))).encode()
        req = urllib.request.Request("https://hist.databento.com/v0/metadata.get_cost", data=q, headers={"Authorization": auth})
        total += float(json.loads(urllib.request.urlopen(req, timeout=300).read().decode()))
    return total


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fav", "main", t) for t in FR.signals("25")]
    if not LISTING: jobs += [("fair", "add", t) for t in fe.fair_signals("s_t18r15")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    if LISTING:
        Z = [r["z"] for r in R]
        rows = sorted({z["want"] for z in Z if not z["have"]})
        print(f"{len(Z)} Friday 0DTE legs picked, {sum(z['have'] for z in Z)} with a book already; {len(rows)} to fetch on {len({x[0] for x in rows})} days")
        with open(os.path.join(HERE, "open37_dbx_list.csv"), "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(rows)
        if rows: print(f"Databento cbbo-1m cost: ${cost(rows):,.2f}")
        return
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    fri = [r for r in R if r["kind"] == "main" and dt.date.fromisoformat(r["date"]).weekday() == 4 and r["minute"] <= LAST_MINUTE]
    print(f"Friday main signals before 13:00: {len(fri)}; a 0DTE leg picked: {sum(1 for r in fri if r.get('z'))}; walked (a book at the buy and the sale): {sum(1 for r in fri if (r.get('z') or {}).get('v'))}")
    out = {}
    table(R, adds, "tune", ("2.10", *ZV), out, "Tune weeks (even)")
    score = lambda v: min(out[f"tune|{v}|{s}|0.02"]["acct"] / out[f"tune|2.10|{s}|0.02"]["acct"] for s in ("fair", "fav"))
    best = max(ZV, key=score)
    out["best"] = best
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs 2.10, 2%): {best} ({score(best):.3f}); better on both: {score(best) > 1}", flush=True)
    table(R, adds, "check", ("2.10", best), out, "Check weeks (odd), the same run")
    json.dump(out, open(f"{B}/fri_0dte_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
