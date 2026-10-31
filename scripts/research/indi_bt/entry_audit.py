"""The entry audit (the user, 2026-10-27: "go and review yourself and try to find issues with the entries - we had huge
issue in the volume bot and now I'm afraid we are not showing something here"). Production 2.6 (c12_15 entries, CHAMP
exits, the cheap fallback, the pre-market skip at 4x, the earnings filter) on the fair list, real quotes, each step
added on the one before:
  A  as reported until today: the quote one minute early (real_bench.quote read the row labelled `minute`, which is the
     book as that minute began, so a fill used the book from before the bar that triggered it)
  B  the quote fixed: the book at the end of the minute before the fill bar = at the decision
  C  B + the live bot's limits on new buys: 8 buys a day, 5 open (overnight ones too), no new buy once the bot's own
     trades of the day are down 5% of the day's start (marked on the real mid; the live brake reads the whole account)
Each at 1%, 2% and 3% a trade (the live bot runs 3%), the 10% overnight cap, $0.62 a contract each way. Also: how many
stock-days the signal code drops for having 300 or fewer minute bars (decided from the whole day), and how often the
live 15% drawdown pause would have turned the bot off.

  node --env-file=.env <dir>/run.mjs entry_audit.py      (from the app repo root)
-> data/local/x/bt/entry_audit_summary.json, entry_audit_trades.csv
"""
import bisect, csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import news_filter as nf
import real_bench as RB
from d2_failed_break import CHAMP
from low_delta import HIS40, PRIOR
from score_sum import account, held
from store import day

B = "data/local/x/bt"
CAL = eb.CAL
LAST = RB.LAST
SIZES = (0.01, 0.02, 0.03)
CAPS = dict(buys=8, open=5, day_loss=0.05)


def quote(c, date, minute, early):
    """The book at the end of `minute`; early=True is the old reading (the book as `minute` began)."""
    if not early: return RB.quote(c, date, minute)
    return RB.quote(c, date, minute - 1) if minute > 0 else None


def price(steps, c, cost, early):
    real, rcost = [], cost
    for d, m, side, q, px, rule in steps:
        if side not in ("buy", "sell"): real.append((d, m, side, q, px, rule)); continue
        at = max(m - 1, 0)
        k = quote(c, d, at, early)
        if not k: real.append((d, m, side, q, px, rule)); continue
        bid, ask = k; mid = (bid + ask) / 2
        p = bid
        if side == "buy":
            p = mid + (ask - mid) / 2
            later = quote(c, d, at + 1, early)
            if later and later[0] > p: p = min(later[1], p * 1.1)
            if rule != "rebuy": rcost = p
        real.append((d, m, side, q, round(p, 4), rule))
    return rcost, real


def one(t):
    p = eb.contract(t, "cheap")
    if not p: return None
    sim.X.clear(); sim.X.update(CHAMP)
    m0 = int(t["minute"])
    cost, steps, _ = sim.walk(t["sym"], t["date"], m0, t["right"], p[0], p[1], CAL)
    if cost is None: return None
    out = dict(date=t["date"], sym=t["sym"], right=t["right"], minute=m0, contract=p[0])
    for tag, early in (("a", True), ("b", False)):
        rcost, real = price(steps, p[0], cost, early)
        out[f"{tag}_cost"] = round(rcost, 4)
        for s in SIZES: out[f"{tag}_r{round(s * 100)}"] = sim.result(rcost, real, s)
        out[f"{tag}_h"] = held(rcost, real)
        if tag == "b":
            sells = [s for s in real if s[2] == "sell"]
            last = sells[-1]
            out["exit_date"], out["exit_minute"] = last[0], last[1]
            # the trade's P&L on the entry day, minute by minute (sold at their fills, the rest on the real mid)
            mark = {}
            for m in range(m0, 390):
                got = sum(s[3] * s[4] for s in sells if s[0] == t["date"] and s[1] <= m)
                left = 1 - sum(s[3] for s in sells if s[0] == t["date"] and s[1] <= m)
                k = RB.quote(p[0], t["date"], m)
                if k and left > 1e-9: mark[m] = round((got + left * (k[0] + k[1]) / 2) / rcost - 1, 4)
                elif left <= 1e-9: mark[m] = round(got / rcost - 1, 4)
            out["mark"] = mark
    out["fill_move"] = None
    ka, kb = quote(p[0], t["date"], m0, True), quote(p[0], t["date"], m0, False)
    if ka and kb: out["fill_move"] = round(((kb[0] + kb[1]) / (ka[0] + ka[1])) - 1, 4)  # the mid's move in the signal bar
    return out


def mark_at(x, m):
    """The trade's entry-day P&L at the latest minute <= m that has a mark (0 before any)."""
    ks = [k for k in x["mark"] if k <= m]
    return x["mark"][max(ks)] if ks else 0


def capped(R, size, key):
    """The live limits, in time order; -> the trades kept and why the rest were refused."""
    R = sorted(R, key=lambda r: (r["date"], r["minute"]))
    kept, why, eq, cur, start, today = [], {"max_buys": 0, "max_open": 0, "day_loss": 0}, 1e5, None, 1e5, []
    for r in R:
        if r["date"] != cur:
            for x in today: eq += size * start * max(-1, x[key])
            cur, start, today = r["date"], eq, []
        m = r["minute"]
        di = CAL.index(r["date"])
        open_ = [x for x in kept if (CAL.index(x["exit_date"]), x["exit_minute"]) > (di, m)]
        down = -sum(size * start * mark_at(x, m) for x in today) / start
        if len(today) >= CAPS["buys"]: why["max_buys"] += 1; continue
        if len(open_) >= CAPS["open"]: why["max_open"] += 1; continue
        if down >= CAPS["day_loss"]: why["day_loss"] += 1; continue
        kept.append(r); today.append(r)
    return kept, why


def stats(R, key, size, a="", z="9"):
    rows = sorted((r for r in R if a <= r["date"] <= z), key=lambda r: (r["date"], r["minute"]))
    if not rows: return None
    h = key.split("_")[0] + "_h"  # the same fills' sale day and 15:50 marks
    pnl = [dict(date=r["date"], pnl=str(1e4 * max(-1, r[key])), **r[h]) for r in rows]
    eq, dd = account(pnl, size)
    top = set(sorted(range(len(rows)), key=lambda i: -rows[i][key])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], size)
    # the live pause: the account down 15% from its best (at the day's start, as account() does)
    e, peak, pauses, cur, st0, armed = 1e5, 1e5, 0, None, 1e5, True
    for r in rows:
        if r["date"] != cur:
            cur, st0 = r["date"], e; peak = max(peak, e)
            if armed and 1 - e / peak >= 0.15: pauses += 1; armed = False
            if e >= peak: armed = True
        e += size * st0 * max(-1, r[key])
    yr = {y: round(sum(1e4 * max(-1, r[key]) for r in rows if r["date"][:4] == y)) for y in ("2024", "2025", "2026")}
    return dict(trades=len(rows), winners=sum(r[key] > 0 for r in rows), per_trade=round(sum(1e4 * max(-1, r[key]) for r in rows) / len(rows)),
                acct=round(eq), dd=round(dd, 4), no_best5=round(a5), years=yr, pauses=pauses,
                best5=[f"{rows[i]['sym']} {rows[i]['date']} {1e4 * rows[i][key]:+,.0f}" for i in sorted(top, key=lambda i: -rows[i][key])])


def short_days(syms):
    """Stock-days the signal code skips for 300 or fewer bars (but some), 2024-02 to LAST."""
    out = []
    for d in CAL:
        if not ("2024-02-01" <= d <= LAST): continue
        for s in syms:
            n = len(day(s, d))
            if 0 < n <= 300: out.append((d, s, n))
    return out


def main():
    T = [t for f in glob.glob(f"{B}/sg_c12_15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    T = [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40
         and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= LAST]
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, T, chunksize=8) if r]
    with open(f"{B}/entry_audit_trades.csv", "w") as f:
        cols = [k for k in R[0] if k not in ("mark", "a_h", "b_h")]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore"); w.writeheader(); w.writerows(R)
    out = {}
    print("| Step | Size | Period | Trades | Winners | Per trade at $10K | End / worst drop | Without best 5 | Years at $10K | Pauses |\n|---|---|---|---|---|---|---|---|---|---|")
    for s in SIZES:
        n = round(s * 100)
        variants = [("A as reported", R, f"a_r{n}", None), ("B quote fixed", R, f"b_r{n}", None)]
        kept, why = capped(R, s, f"b_r{n}")
        variants.append(("C fixed + live limits", kept, f"b_r{n}", why))
        for name, rows, key, w in variants:
            for per, a, z in (("2024-25", "2024-01-01", "2025-12-31"), ("2026", "2026-01-01", "2026-12-31"), ("all", "", "9")):
                x = stats(rows, key, s, a, z)
                out[f"{name}|{n}|{per}"] = dict(step=name, size=n, period=per, refused=w, **x)
                print(f"| {name} | {n}% | {per} | {x['trades']} | {x['winners']} | {x['per_trade']:+,} | ${x['acct']:,} / {x['dd']:.0%} | ${x['no_best5']:,} | "
                      f"{x['years']['2024']:+,} / {x['years']['2025']:+,} / {x['years']['2026']:+,} | {x['pauses']} |", flush=True)
        print(f"refused at {n}%:", why, flush=True)
    mv = sorted(r["fill_move"] for r in R if r["fill_move"] is not None)
    out["fill_move"] = dict(n=len(mv), median=mv[len(mv) // 2], mean=sum(mv) / len(mv), up=sum(x > 0 for x in mv) / len(mv))
    print("the option's mid in the signal bar (old book -> fixed book):", out["fill_move"], flush=True)
    sd = short_days(sorted(HIS40))
    out["short_days"] = dict(n=len(sd), sample=sd[:20])
    print("stock-days with 1-300 bars (skipped by the signal code):", len(sd), sd[:12], flush=True)
    json.dump(out, open(f"{B}/entry_audit_summary.json", "w"), indent=1)


if __name__ == "__main__": main()
