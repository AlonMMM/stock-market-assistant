"""The alert strangle again, on real bid/ask (the user, 2026-10-27: "go back to our old strategies? buy strangle and keep
only one leg with confirmation? try to tune the enter and make it faster"). The Volume bot's alerts over the last 12
months on the watchlist (sec_cache/events.json, the expiry as the live bot: same day, else the next day). At the alert
both legs are bought; when the stock moves K x S30 from its price then, the wrong leg is sold (optionally its money goes
into the right leg); the kept leg runs to its exit; no side within WAIT minutes -> both out.
Quotes: OPRA cbbo-1m of every call and put near the money at the alert (delta 0.15-0.60) -> strangle_cache/<date>.csv.gz.
  node --env-file=.env <dir>/run.mjs strangle_real.py list|cost|fetch|run      (from the app repo root)
"""
import bisect, csv, gzip, json, multiprocessing as mp, os, sys
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, iv_delta
from cheap_up import candidates
import dbx_fetch as F

C = sim.C
EV = os.path.join(HERE, "sec_cache", "events.json")
LIST = os.path.join(HERE, "strangle_dbx_list.csv")
OUT = os.path.join(HERE, "strangle_cache")
LO, HI = 0.15, 0.60
COMM = 0.62
END = 360
DELTAS = (0.25, 0.35, 0.50)
KS = (0.15, 0.25, 0.40)
WAITS = (5, 10, 30, 60)
EXITS = ("opt30", "stk75", "stk50")
Q = {}


def quotes(date):
    if date not in Q:
        Q.clear(); by = {}
        path = os.path.join(OUT, f"{date}.csv.gz")
        if os.path.exists(path):
            for r in csv.DictReader(gzip.open(path, "rt")):
                if r["bid"] and r["ask"] and float(r["ask"]) > 0: by.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
        for v in by.values(): v.sort()
        Q[date] = by
    return Q[date]


def quote(c, date, minute):
    """The book as the minute closed (the row stamped m+1), at most 5 minutes old. -> (bid, ask) or None."""
    v = quotes(date).get(c)
    if not v: return None
    i = bisect.bisect(v, (minute + 1, 1e9, 1e9)) - 1
    if i < 0 or v[i][0] < minute - 4: return None
    return v[i][1], v[i][2]


def buy_at(c, date, minute, q):
    """Mid + half the way to the ask; the chase when the next minute's bid is already above it."""
    price = (q[0] + q[1]) / 2 + (q[1] - q[0]) / 4
    later = quote(c, date, minute + 1)
    if later and later[0] > price: return min(later[1], price * 1.1)
    return price


def pair(e, delta):
    """The call and the put nearest the delta, by the real mid at the alert. -> {right: (contract, ask-bid quote)}."""
    if e["kind"] == "0": C.update(dte_min=0, dte_max=0)
    else: C.update(dte_min=1, dte_max=5)
    out = {}
    for right in ("C", "P"):
        best = None
        for c in candidates(e["sym"], e["date"], e["m"], right, e["stock0"]):
            if c[1] != e["nxt"]: continue
            q = quote(c[0], e["date"], e["m"])
            if not q or q[0] <= 0: continue
            mid = (q[0] + q[1]) / 2
            x = iv_delta(mid, e["stock0"], c[2], sim.years_to_expiry(e["date"], e["m"], c[1]), C["rate"], right == "C")
            if x is None or mid < 0.10: continue
            if best is None or abs(abs(x[1]) - delta) < abs(abs(best[2]) - delta): best = (c[0], q, x[1])
        if not best or abs(abs(best[2]) - delta) > 0.12: return None
        out[right] = best[:2]
    return out


def kept_exit(e, sb, c, ct, side, how):
    """The kept leg's sale after the side: (bid, minute)."""
    date, u = e["date"], e["u"]
    best_s = sb[ct][4]; q0 = quote(c, date, ct); peak = (q0[0] + q0[1]) / 2 if q0 else 0; last = q0
    for t in range(ct + 1, END + 1):
        q = quote(c, date, t)
        if q: last = q
        if t >= END: break
        if how == "opt30":
            if q:
                mid = (q[0] + q[1]) / 2; peak = max(peak, mid)
                if mid <= peak * 0.7: break
        else:
            g = 0.75 if how == "stk75" else 0.50
            if t in sb:
                s = sb[t][4]; best_s = max(best_s, s) if side == "C" else min(best_s, s)
                if abs(s / best_s - 1) >= g * u: break
    return (last[0] if last else 0.0), t


def sims(e):
    """Every version's trade for one alert: (delta, K, wait, recycle, exit, date, sym, m, xm, cost, got, spread)."""
    sb = {b[0]: b for b in day(e["sym"], e["date"])}
    out = []
    for delta in DELTAS:
        pr = pair(e, delta)
        if not pr: continue
        date, m = e["date"], e["m"]
        paid = {r: buy_at(c, date, m, q) for r, (c, q) in pr.items()}
        cost = sum(paid.values())
        spread = sum(q[1] - q[0] for c, q in pr.values()) / sum((q[1] + q[0]) / 2 for c, q in pr.values())
        for K in KS:
            for W in WAITS:
                side = None
                for t in range(m + 1, min(m + W, END) + 1):
                    if t in sb and abs(sb[t][4] / e["stock0"] - 1) >= K * e["u"]: side = (t, "C" if sb[t][4] > e["stock0"] else "P"); break
                if not side:
                    t = min(m + W, END); qs = [quote(c, date, t) for c, q in pr.values()]
                    got = sum(q[0] for q in qs if q)
                    for rec in (0, 1):
                        for ex in EXITS: out.append((delta, K, W, rec, ex, date, e["sym"], m, t, cost, got - COMM * 2 / 100, spread))
                    continue
                ct, right = side; wrong = "P" if right == "C" else "C"
                qw = quote(pr[wrong][0], date, ct); qk = quote(pr[right][0], date, ct)
                if not qw or not qk: continue
                w = qw[0]; add = buy_at(pr[right][0], date, ct, qk)
                for ex in EXITS:
                    sk, xm = kept_exit(e, sb, pr[right][0], ct, right, ex)
                    out.append((delta, K, W, 0, ex, date, e["sym"], m, xm, cost, w + sk - COMM * 2 / 100, spread))
                    units = 1 + w / add
                    out.append((delta, K, W, 1, ex, date, e["sym"], m, xm, cost, units * sk - COMM * (1 + w / add + units) / 100, spread))
    return out


def contracts_of(e):
    """Every call and put the strangle could pick at the alert minute."""
    if e["kind"] == "0": C.update(dte_min=0, dte_max=0)
    else: C.update(dte_min=1, dte_max=5)
    out = []
    for right in ("C", "P"):
        out += [(e["date"], c[0], e["m"]) for c in candidates(e["sym"], e["date"], e["m"], right, e["stock0"])
                if c[1] == e["nxt"] and LO <= abs(c[3]) <= HI]
    return out


def cost(syms, start, end):
    data = F.urllib.parse.urlencode(dict(dataset="OPRA.PILLAR", schema="cbbo-1m", stype_in="raw_symbol",
                                         symbols=",".join(F.pad(s) for s in syms), start=start, end=end)).encode()
    req = F.urllib.request.Request("https://hist.databento.com/v0/metadata.get_cost", data=data, headers={"Authorization": F.AUTH})
    return float(F.urllib.request.urlopen(req, timeout=300).read().decode())


def fetch_day(item):
    date, cs = item
    path = os.path.join(OUT, f"{date}.csv.gz")
    if F.fresh(path, F.HEAD): return
    start = min(cs.values())
    rows = []
    for r in F.get(sorted(cs), "cbbo-1m", F.utc(date, start), F.utc(date, F.END)):
        if not r["bid_px_00"] or not r["ask_px_00"]: continue
        t = F.datetime.fromisoformat(r["ts_recv"].replace("Z", "+00:00")).astimezone(F.NY)
        rows.append((r["symbol"].replace(" ", ""), t.hour * 60 + t.minute - 570, r["bid_px_00"], r["ask_px_00"], r["bid_sz_00"], r["ask_sz_00"]))
    F.save(path, F.HEAD, rows)


def main():
    step = sys.argv[1]
    ev = json.load(open(EV))
    if step == "list":
        with mp.Pool(8) as pool: res = pool.map(contracts_of, ev, chunksize=8)
        best = {}
        for rs in res:
            for d, c, m in rs: best[(d, c)] = min(m, best.get((d, c), 999))
        with open(LIST, "w") as f:
            w = csv.writer(f); w.writerow(["date", "contract", "minute"]); w.writerows(sorted((d, c, m) for (d, c), m in best.items()))
        print(len(best), "contract-days on", len({d for d, c in best}), "days"); return
    days = {}
    for r in csv.DictReader(open(LIST)):
        days.setdefault(r["date"], {})[r["contract"]] = int(r["minute"])
    if step == "cost":
        import random
        random.seed(1); pick = random.sample(sorted(days), 12)
        tot = 0
        for d in pick:
            cs = days[d]
            c = cost(sorted(cs), F.utc(d, min(cs.values())), F.utc(d, F.END))
            print(d, len(cs), f"${c:.3f}", flush=True); tot += c
        print("estimate all days $", round(tot / len(pick) * len(days), 2)); return
    if step == "fetch":
        os.makedirs(OUT, exist_ok=True)
        with ThreadPoolExecutor(10) as ex:
            for n, _ in enumerate(ex.map(fetch_day, sorted(days.items()))):
                if n % 20 == 0: print(n, "/", len(days), flush=True)
        return
    if step == "run":
        import news_filter as nf
        if os.environ.get("STR_TOP"):
            top = set(json.load(open(os.path.join(HERE, "strangle_rank.json")))[:int(os.environ["STR_TOP"])])
            ev = [e for e in ev if e["sym"] in top]
        if os.environ.get("STR_EARLY") == "1":   # the best case for a faster entry: the book as the alert minute began
            ev = [dict(e, m=e["m"] - 1, stock0=b[e["m"] - 1][4]) for e in ev for b in [{x[0]: x for x in day(e["sym"], e["date"])}] if e["m"] - 1 in b]
        import leg_daycap as D
        with mp.Pool(8) as pool: res = pool.map(sims, sorted(ev, key=lambda e: e["date"]), chunksize=16)
        rows = [dict(date=d, sym=s_, minute=0, right="C") for d, s_ in {(e["date"], e["sym"]) for e in ev}]
        nf.features(rows)
        skip = {(r["date"], r["sym"]) for r in rows if r["e_next"] == 0 or (r["pre_rvol"] is not None and r["pre_rvol"] >= 4)}
        V = {}
        for rs in res:
            for r in rs:
                if (r[5], r[6]) not in skip: V.setdefault(r[:5], []).append(r)
        out = []
        for key, T in V.items():
            for how in ("first", "flat2"):
                for cap in (9, 0.25, 0.15):
                    by = {}
                    for r in sorted(T, key=lambda r: r[7]):
                        if r[11] > cap: continue
                        by.setdefault((r[5], r[6]), []).append(r)
                    keep = []
                    for v in by.values():
                        if how == "first": keep += [v[0]] if v[0][7] == min(x[7] for x in v) else []
                        else:
                            busy = -1; n = 0
                            for r in v:
                                if r[7] > busy and n < 2: keep.append(r); busy = r[8]; n += 1
                    tr = [dict(date=r[5], sym=r[6], minute=r[7], bm=r[7], xm=r[8], buy=r[9], sell=r[10]) for r in keep]
                    for lab, lo in (("12m", "0000"), ("6m", "2026-04-23")):
                        S = [t for t in tr if t["date"] >= lo]
                        eq, dd, R, _, _ = D.account(S, 1, 2, loss=7.5, max_trades=15, max_open=5)
                        avg = sum(r["sell"] / r["buy"] - 1 for r in R) / max(1, len(R))
                        win = sum(r["sell"] > r["buy"] for r in R) / max(1, len(R))
                        out.append(dict(zip(("delta", "K", "wait", "recycle", "exit"), key), how=how, cap=cap, span=lab, n=len(R), avg=avg, win=win, end=eq, dd=dd))
        json.dump(out, open(os.path.join(HERE, f"strangle_real_out{os.environ.get('STR_TOP', '')}{'e' if os.environ.get('STR_EARLY') == '1' else ''}.json"), "w"))
        top = sorted([o for o in out if o["span"] == "12m"], key=lambda o: -o["end"])
        six = {tuple((k, o[k]) for k in ("delta", "K", "wait", "recycle", "exit", "how", "cap")): o for o in out if o["span"] == "6m"}
        print("| delta | K | wait | recycle | exit | alerts | spread cap | trades | avg | win | 12m end, drop | 6m end, drop |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        old = [o for o in top if (o["delta"], o["K"], o["wait"], o["recycle"], o["exit"], o["how"], o["cap"]) == (0.35, 0.25, 60, 1, "opt30", "first", 9)]
        for o in top[:20] + old:
            x = six[tuple((k, o[k]) for k in ("delta", "K", "wait", "recycle", "exit", "how", "cap"))]
            print(f"| {o['delta']} | {o['K']} | {o['wait']} | {o['recycle']} | {o['exit']} | {o['how']} | {o['cap']} | {o['n']} | {100 * o['avg']:+.1f}% | {100 * o['win']:.0f}% | ${o['end']:,.0f}, {100 * o['dd']:.0f}% | ${x['end']:,.0f}, {100 * x['dd']:.0f}% |")
        print("combos", len(top), "| profitable 12m:", sum(o["end"] > 1e5 for o in top))


if __name__ == "__main__": main()
