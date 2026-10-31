"""Two fallbacks in the contract pick, on the champion's own signals (the user, 2026-10-25):
  cheap:  when the 0.15-delta option costs under min_price ($0.20), take the nearest-the-money strike that costs
          $0.20 or more, the one closest to $0.20 (a higher delta); the liquidity floor still applies.
  liquid: when the 0.15-delta option has under min_vol30 (200) contracts in the last 30 minutes, take the nearest
          strike toward the money that has them (delta up to 0.35), still $0.20 or more.
  both:   cheap, then liquid on the result.
The signals that were "too_cheap" / "illiquid" in the champion's files are re-picked and walked with the champion's
exits (t-stat exit, overnight from +50%, the rest stop -20%) and with the live bot 2.3's; the champion's own trades
are walked too, so the baseline is reproduced here (fair list 813 trades, $811,353 / 11% at 1% on 2026-10-25).
Fair list and 151 unseen; 1% / 2% from $100,000.

  node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs cheap_up.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import news_filter as nf
from store import calendar, day, iv_delta
from tiers_round import H, NIGHT
from low_delta import HIS40, PRIOR
from score_sum import account, held

B = "data/local/x/bt"
CAL = calendar()
C = sim.C
BOT = {**sim.X, **H, **NIGHT, "failed_break": True, "thesis": {"t": 0.5}, "carry_min_gain": 0.5}
CHAMP = {**sim.X, **H, **NIGHT, "thesis": {"t": 0.5}, "carry_min_gain": 0.5, "after_half": dict(out=-0.2)}
EXITS = [("Champion", CHAMP), ("Bot 2.3", BOT)]
MAX_DELTA = 0.35


def candidates(und, date, minute, right, spot):
    """Every OTM strike the picker scans: (symbol, expiry, strike, delta, price, vol30, iv), nearest the money first."""
    exp = sim.expiry_for(und, date)
    if not exp: return []
    call = right == "C"
    allk = sim.chain(und, exp, right)
    ks = [k for k in allk if (spot <= k <= spot * (1 + C["otm_scan_max"]) if call else spot * (1 - C["otm_scan_max"]) <= k <= spot)]
    ks = sorted(ks, key=lambda k: abs(k - spot))[:C["max_strikes"]]
    T = sim.years_to_expiry(date, minute, exp)
    out = []
    for k in ks:
        s = sim.occ(und, exp, k, right)
        b = sim.last_bar(day(s, date), minute, C["bar_max_age"])
        if not b: continue
        x = iv_delta(b[4], spot, k, T, C["rate"], call)
        if x is None: continue
        iv, d = x
        out.append((s, exp, k, d, b[4], sum(y[5] for y in day(s, date) if minute - 30 < y[0] <= minute), iv))
    return out


def choose(cands, mode):
    """The picker's choice, then the fallbacks. -> candidate or (None, reason)."""
    if not cands: return None, "no_prices"
    best = min(cands, key=lambda c: abs(c[3] - C["delta"]))
    if mode in ("cheap", "both") and best[4] < C["min_price"]:
        ok = [c for c in cands if c[4] >= C["min_price"] and abs(c[3]) >= abs(best[3])]
        if not ok: return None, "too_cheap"
        best = min(ok, key=lambda c: c[4])  # the one closest to $0.20 from above
    if mode in ("liquid", "both") and best[5] < C["min_vol30"]:
        ok = [c for c in cands if c[5] >= C["min_vol30"] and c[4] >= C["min_price"] and abs(best[3]) <= abs(c[3]) <= MAX_DELTA]
        if not ok: return None, "illiquid"
        best = min(ok, key=lambda c: abs(c[3]))  # the nearest step toward the money that has the crowd
    if best[4] < C["min_price"]: return None, "too_cheap"
    if best[5] < C["min_vol30"]: return None, "illiquid"
    return best, None


def one(t):
    """-> key, {version name: ret} for the plain pick (the champion's own contract) and each fallback mode."""
    key = (t["date"], t["sym"], t["minute"])
    out = {}
    minute, spot = int(t["minute"]), float(t["price"])
    picks = {}
    if t["status"] == "ok": picks["plain"] = (t["contract"], t["expiry"], None)
    cands = candidates(t["sym"], t["date"], minute, t["right"], spot) if t["status"] in ("too_cheap", "illiquid") else []
    for mode in ("cheap", "liquid", "both"):
        if t["status"] == "ok": picks[mode] = picks["plain"]; continue
        c, why = choose(cands, mode)
        picks[mode] = (c[0], c[1], c) if c else None
    for mode, p in picks.items():
        if not p: continue
        csym, exp, c = p
        for name, rb in EXITS:
            sim.X.clear(); sim.X.update(rb)
            cost, steps, _ = sim.walk(t["sym"], t["date"], minute, t["right"], csym, exp, CAL)
            if cost is None: continue
            out[f"{name}|{mode}"] = sim.result(cost, steps)
            out[f"{name}|{mode}#h"] = held(cost, steps)
            if c: out[f"{name}|{mode}|pick"] = (round(c[3], 3), c[4], c[5])
    return key, out


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    print(f"{len(T)} signals after the news filter:", {s: sum(t['status'] == s for t in T) for s in ('ok', 'too_cheap', 'illiquid')}, flush=True)
    with mp.Pool(6) as pool: R = dict(pool.map(one, T, chunksize=8))
    key = lambda t: (t["date"], t["sym"], t["minute"])
    pt = lambda x: 1e4 * max(-1, x)
    for lname, lf in (("fair list", lambda t: t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]), ("151 unseen", lambda t: t["sym"] not in HIS40)):
        L = [t for t in T if lf(t)]
        print(f"\n### {lname}: {len(L)} signals ({sum(t['status'] == 'too_cheap' for t in L)} too cheap, {sum(t['status'] == 'illiquid' for t in L)} illiquid)\n")
        print("| Exits | Pick | Trades | Winners | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 / 2026 at $10K | Without the best 5 at 1% | Added trades: n, winners, per trade, sum |\n|---|---|---|---|---|---|---|---|---|")
        for name, _ in EXITS:
            for mode in ("plain", "cheap", "liquid", "both"):
                k = f"{name}|{mode}"
                rows = [dict(date=t["date"], pnl=str(pt(R[key(t)][k])), sym=t["sym"], added=t["status"] != "ok",
                             **R[key(t)][k + "#h"]) for t in L if k in R[key(t)]]
                if not rows: continue
                a1, d1 = account(rows); a2, d2 = account(rows, 0.02)
                top = set(sorted(range(len(rows)), key=lambda i: -float(rows[i]["pnl"]))[:5])
                a5, _ = account([r for i, r in enumerate(rows) if i not in top])
                yr = " / ".join(f"{sum(float(r['pnl']) for r in rows if r['date'][:4] == y) / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
                add = [float(r["pnl"]) for r in rows if r["added"]]
                win = sum(float(r["pnl"]) > 0 for r in rows)
                added = f"{len(add)}, {sum(x > 0 for x in add)}, {sum(add) / len(add):+,.0f}, {sum(add) / 1e3:+,.0f}K" if add else ""
                print(f"| {name} | {mode} | {len(rows)} | {win} | ${a1:,.0f} / {100 * d1:.0f}% | ${a2:,.0f} / {100 * d2:.0f}% | {yr} | ${a5:,.0f} | {added} |")
        for mode in ("cheap", "liquid"):
            k = f"Champion|{mode}"
            add = sorted(((pt(R[key(t)][k]), t["sym"], t["date"], R[key(t)].get(k + "|pick")) for t in L if t["status"] != "ok" and k in R[key(t)]), reverse=True)
            if not add: continue
            import statistics as st
            print(f"\n{mode}: picks delta median {st.median(p[0] for _, _, _, p in add):.2f}, price median ${st.median(p[1] for _, _, _, p in add):.2f}; best", [(s, d, f"{x:+,.0f}") for x, s, d, _ in add[:5]], "worst", [(s, d, f"{x:+,.0f}") for x, s, d, _ in add[-3:]])
            by = {}
            for x, s, d, _ in add: by.setdefault(s, []).append(x)
            print(f"{mode}: by stock (sum, n), top", sorted(((f"{sum(v) / 1e3:+,.0f}K", len(v), s) for s, v in by.items()), key=lambda r: -float(r[0][:-1].replace(',', '')))[:6])


if __name__ == "__main__":
    main()
