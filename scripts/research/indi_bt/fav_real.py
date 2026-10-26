"""The candidates on today's Favorites, old prices against real quotes (the user, 2026-10-26: "after that we will take
the candidate and test them on my favorite"; "can you also run the backtest on todays favorites and show me results in
artifact?"). Today's Favorites: 69 stocks (the 68 of fav68 + TSEM, added since). Signals: lists.py runs fav68_24 /
tsem_24 (2.4's entry) and fav68_25 / tsem_25 (2.5's, the D2 bonus), 2025-10-23 to 2026-10-23. Real quotes: Databento OPRA
cbbo-1m for those contracts (fav_dbx.py -> dbx_cache/fav/); pricing as real_bench.py (a buy at the mid + half the way to
the ask, a sale at the bid). Versions:
  2.4, 2.5, 2.6 (= 2.5 + the cheap fallback, live)
  pyramid            2.6, a D2 entry (t < 1.8) at full size plus half a size of 2.4's entry later that day, same side, while
                     the D2 position is still held and above its cost on the real mid (cand_real.py)
  pyramid+fb-half    the same, a cheap-fallback trade at half size
Last 12 and last 6 months, 1% and 2% from $100,000, the 10% overnight cap at each size, $0.62 a contract each way.

  node --env-file=.env <dir>/run.mjs fav_real.py      (from the app repo root)
-> data/local/x/bt/fav_real_summary.json, fav_real_trades.csv
"""
import csv, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import cheap_up2 as cu2
import real_bench as RB
import opt_spread as OS
from d2_failed_break import CHAMP
from score_sum import account

RB.DBX = os.path.join(HERE, "dbx_cache", "fav")
B = "data/local/x/bt"
CAL = RB.CAL
A12, A6, Z = "2025-10-23", "2026-04-23", "2026-10-23"
STATUS = {"bought": "ok", "no contract: illiquid": "illiquid", "no contract: too_cheap": "too_cheap"}
LISTS = {"24": ("fav68_24", "tsem_24"), "25": ("fav68_25", "tsem_25")}


def signals(entry):
    out = []
    for name in LISTS[entry]:
        path = f"{B}/list_{name}_{A12}_{Z}.json"
        if not os.path.exists(path): print("missing", path); continue
        for r in json.load(open(path)):
            st = STATUS.get(r["status"])
            if st: out.append(dict(r, status=st, minute=str(r["minute"]), c_t=str(r["c_t"])))
    return out


def one(job):
    kind, t = job   # kind: v24 / v25 / v26 (the trade of that version) / add (2.4's entry, for the pyramid)
    fb = "cheap" if kind in ("v26", "add") else None
    if kind != "v26" and kind != "add" and t["status"] != "ok": return None
    p = eb.contract(t, fb)
    if not p: return None
    sim.X.clear(); sim.X.update(cu2.BOT24 if kind == "v24" else CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], p[0], p[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, p[0], cost, "bid")
    miss = sum(1 for d, m, side, q, px, rule in steps if side in ("buy", "sell") and not RB.quote(p[0], d, max(m - 1, 0)))
    row = dict(kind=kind, date=t["date"], sym=t["sym"], right=t["right"], minute=int(t["minute"]), contract=p[0],
               src="cheap" if t["status"] == "too_cheap" else "pick", d2=int(float(t["c_t"]) < 1.8),
               old1=sim.result(cost, steps, 0.01), old2=sim.result(cost, steps, 0.02), old05=sim.result(cost, steps, 0.005), old1_=sim.result(cost, steps, 0.01),
               real1=sim.result(rcost, real, 0.01), real2=sim.result(rcost, real, 0.02), real05=sim.result(rcost, real, 0.005),
               fills=sum(s[2] in ("buy", "sell") for s in steps), no_quote=miss)
    if kind == "v26":
        held = {}
        sells = [s for s in real if s[2] == "sell" and s[0] == t["date"]]
        for m in range(int(t["minute"]), 390):
            k = RB.quote(p[0], t["date"], m)
            held[m] = (1 - sum(s[3] for s in sells if s[1] <= m), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
        row["held"] = held
    return row


def stats(E, a, size):
    """E: (date, minute, units, ret at 1% a unit's cap, ret at 2%..., sym) -> account at `size` per unit."""
    R = sorted([e for e in E if e[0] >= a])
    if not R: return None
    k = 3 if size == 0.01 else 4
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[k]))) for e in R]
    acct, dd = account(pnl, size)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], size)
    return dict(trades=len(R), winners=sum(e[3] > 0 for e in R), per_trade=round(sum(1e4 * e[2] * max(-1, e[3]) for e in R) / len(R)),
                acct=round(acct), dd=round(dd, 4), no_best5=round(a5),
                best5=[dict(sym=R[i][5], date=R[i][0], pnl=round(1e4 * R[i][2] * R[i][3])) for i in sorted(top, key=lambda i: -R[i][2] * R[i][3])])


def main():
    S24, S25 = signals("24"), signals("25")
    jobs = [("v24", t) for t in S24] + [("v25", t) for t in S25] + [("v26", t) for t in S25] + [("add", t) for t in S24]
    with mp.Pool(8) as pool: res = [r for r in pool.map(one, jobs, chunksize=8) if r]
    with open(f"{B}/fav_real_trades.csv", "w") as f:
        keys = [k for k in res[0] if k != "held"]
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore"); w.writeheader(); w.writerows(res)
    adds = {}
    for r in res:
        if r["kind"] == "add": adds.setdefault((r["date"], r["sym"], r["right"]), []).append(r)
    versions = {}
    for kind, name in (("v24", "2.4"), ("v25", "2.5"), ("v26", "2.6 (live)")):
        versions[name] = [r for r in res if r["kind"] == kind]
    out = {}
    for name in ("2.4", "2.5", "2.6 (live)", "pyramid", "pyramid+fb-half"):
        base = versions.get(name) or versions["2.6 (live)"]
        for price in ("old", "real"):
            E = []
            for r in base:
                units = 0.5 if name == "pyramid+fb-half" and r["src"] == "cheap" else 1.0
                if units == 1: E.append((r["date"], r["minute"], 1.0, r[f"{price}1"], r[f"{price}2"], r["sym"]))
                else: E.append((r["date"], r["minute"], 0.5, r[f"{price}05"], r[f"{price}1"], r["sym"]))
                if name.startswith("pyramid") and r["d2"]:
                    for a in sorted(adds.get((r["date"], r["sym"], r["right"]), []), key=lambda x: x["minute"]):
                        if a["minute"] <= r["minute"]: continue
                        share, up = r["held"].get(a["minute"], (0, None))
                        if share > 0 and up is not None and up > 0: E.append((a["date"], a["minute"], 0.5, a[f"{price}05"], a[f"{price}1"], a["sym"]))
                        break
            for period, a in (("12m", A12), ("6m", A6)):
                for size in (0.01, 0.02):
                    out[f"{name}|{price}|{period}|{int(size * 100)}"] = dict(version=name, price=price, period=period, size=size, **stats(E, a, size))
        o, rl = out[f"{name}|old|12m|1"], out[f"{name}|real|12m|1"]
        print(f"| {name} | {o['trades']} | ${o['acct']:,} / {o['dd']:.0%} | ${rl['acct']:,} / {rl['dd']:.0%} | ${out[f'{name}|real|12m|2']['acct']:,} / {out[f'{name}|real|12m|2']['dd']:.0%} | ${rl['no_best5']:,} | ${out[f'{name}|real|6m|1']['acct']:,} / {out[f'{name}|real|6m|1']['dd']:.0%} |", flush=True)
    nq = sum(r["no_quote"] for r in res); nf_ = sum(r["fills"] for r in res)
    print(f"fills without a quote: {nq} of {nf_}")
    json.dump(dict(rows=out, no_quote=nq, fills=nf_), open(f"{B}/fav_real_summary.json", "w"), indent=1)


if __name__ == "__main__": main()
