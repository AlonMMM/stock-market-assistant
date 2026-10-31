"""The champion bot on one of the user's watchlists over a date range: t >= 1.8, day volume >= 1.5x, the news filter,
delta 0.15, your stop + the overnight hold (BT_FAILED_BREAK=1: plus the failed-break sale; BT_THESIS=0.5: the t-stat
exit; BT_HOLD=0.5: hold overnight from +50%; all three = the live bot, version 2.3, since 2026-10-24; BT_REST=-0.2: the rest out at -20% after the +10 half, version 2.4; BT_ENTRY=c12_15: the D2 bonus entry, the champion since 2026-10-25). Fetches the days first (stocks, pre-market, earnings; option bars as the
picker needs them), then walks every trade. Same code path as week.py, for any list of symbols.

  node --env-file=.env <path>/run.mjs lists.py run <first day> <last day> <list name> SYM1,SYM2,...   (from the repo root)
      -> data/local/x/bt/list_<name>_<first>_<last>.json
  python3 lists.py summary <first day> <last day> <list name> [<list name> ...]
      -> per list: trades, per trade at $10K, winners, the account at 1% and 2% from $100,000, worst drop, by stock
"""
import collections, datetime as dt, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
B = "data/local/x/bt"


def run(A, Z, name, syms):
    from store import P, fetch_bars, calendar
    from fetch_context import pre
    import earnings
    start = (dt.date.fromisoformat(A) - dt.timedelta(days=45)).isoformat()
    allsyms = ["SPY"] + syms
    for i in range(0, len(allsyms), 50):
        part = allsyms[i:i + 50]
        fetch_bars("stocks", part, start, Z, key=f"list|{','.join(part)}|{start}|{Z}")
        pre(part, start, Z)
    # earnings.json is built for the known universes only; widen it so the news filter knows these stocks too
    P["universe_fav"] = sorted(set(P.get("universe_fav", [])) | set(syms))
    earnings.main("2022-12-01", Z)
    print("data ready", flush=True)

    import sim, tune_signals as ts, news_filter as nf
    from tiers_round import H, NIGHT
    ts.SPAN = {"w": (A, Z)}; ts.RULES = {"t18r15": (1.8, 1.5, None)}
    # BT_ENTRY=c12_15: the D2 bonus entry (defence_signals.py; the champion since 2026-10-25) instead of t >= 1.8 alone
    entry = os.environ.get("BT_ENTRY")
    if entry:
        import defence_signals as ds
        ds.SPAN = {"w": (A, Z)}; ds.RULES = {entry: ds.RULES[entry]}
    sim.X.update(dict(H, **NIGHT))
    if os.environ.get("BT_FAILED_BREAK"): sim.X["failed_break"] = True  # the bot's failed-break sale (sim.py F)
    if os.environ.get("BT_THESIS"): sim.X["thesis"] = {"t": float(os.environ["BT_THESIS"])}  # the t-stat exit (2026-10-24 champion)
    if os.environ.get("BT_HOLD"): sim.X["carry_min_gain"] = float(os.environ["BT_HOLD"])  # hold overnight from this gain (0.5 since 2026-10-24)
    if os.environ.get("BT_REST"): sim.X["after_half"] = dict(out=float(os.environ["BT_REST"]))  # the rest at this gain after the +10 half (2026-10-24 night champion)
    CAL = calendar()
    sig = [r for s in syms for r in (ds.stock(s)[entry] if entry else ts.stock(s)["t18r15"])]
    nf.CAL[:] = CAL; nf.IDX.clear(); nf.IDX.update({d: i for i, d in enumerate(CAL)})
    nf.features(sig)
    # BT_HOT=a.json,b.json: {month: [symbols]} (hot_universe.py); a signal in a month its stock is in none of them is not traded
    hot = {}
    for f in filter(None, os.environ.get("BT_HOT", "").split(",")):
        for m, v in json.load(open(f)).items(): hot.setdefault(m, set()).update(v)
    out = []
    for n, t in enumerate(sorted(sig, key=lambda r: (r["date"], r["minute"]))):
        row = dict(t, list=name)
        if hot and t["sym"] not in hot.get(t["date"][:7], ()): row["status"] = "skipped: not hot"
        elif t["e_next"] == 0: row["status"] = "skipped: earnings reaction day"
        elif t["pre_rvol"] is not None and t["pre_rvol"] >= 4: row["status"] = f"skipped: pre-market volume {t['pre_rvol']:.1f}x"
        else:
            picked, why = sim.pick(t["sym"], t["date"], t["minute"], t["right"], float(t["price"]))
            if not picked: row["status"] = f"no contract: {why}"
            else:
                csym, exp, k, dl, px, v30, iv = picked
                cost, steps, flag = sim.walk(t["sym"], t["date"], t["minute"], t["right"], csym, exp, CAL)
                if cost is None: row["status"] = "no fill"
                else:
                    sold = sum(s[3] for s in steps if s[2] == "sell")
                    row.update(status="bought", contract=csym, expiry=exp, strike=k, delta=round(dl, 3), cost=round(cost, 2), iv=round(iv, 3) if iv else None,
                               steps=";".join(f"{s[0]} {s[1]} {s[2]} {s[3]:.2f} @{s[4]:.2f} {s[5]}" for s in steps[1:]),
                               ret=round(sim.result(cost, steps), 4) if sold >= 0.999 else None, open_share=round(1 - sold, 2),
                               ret_2pct=round(sim.result(cost, steps, 0.02), 4) if sold >= 0.999 else None,
                               ret_nocap=round(sim.result(cost, steps, 0), 4) if sold >= 0.999 else None,
                               next_report=t["e_next"])
        out.append(row)
        if n % 25 == 0: print(f"{n}/{len(sig)} {t['date']}", flush=True)
    json.dump(out, open(f"{B}/list_{name}_{A}_{Z}.json", "w"), default=str, indent=1)
    print(name, len(out), "signals,", sum(r["status"] == "bought" for r in out), "bought", flush=True)


def ret_at(r, pct):
    """The trade's return at a size of `pct` of the account: `ret` is at 1% with the overnight cap (sim.py NIGHT_CAP),
    `ret_2pct` at 2%; a list written before the cap (2026-10-25) has only `ret`."""
    if pct <= 0.01: return r["ret"]
    return r.get(f"ret_{round(pct * 100)}pct", r["ret"])


# The account audit (the user, 2026-10-31: "overnight profits are counted too early. A trade's whole multi-day result is
# added to equity on its entry day, and the next day's trades are sized on that money"). BT_ACCT=exit (the default):
# a trade's P&L joins the account at the end of the day of its last sale (BT_ACCT=exit: a day's trades are sized on
# closed trades only). BT_ACCT=entry reproduces the runs before it.
# Corrected the same day (the user: "the big trade after a big trade is very rare"): sizing on closed trades only
# understates (the live bot sizes on its account value, open positions marked), so the default is BT_ACCT=marked: a day
# starts with the closed trades plus each open trade marked at its last 15:50 carry price; the drop counts the marks.
ACCT = os.environ.get("BT_ACCT", "marked")


def exit_day(r):
    """The day of the trade's last sale (its entry day when the steps say nothing later)."""
    days = [x.split(" ")[0] for x in (r.get("steps") or "").split(";") if " sell " in x]
    return max(days + [r["date"]])


def account(T, pct, start=100_000):
    """Each trade costs `pct` of the account at the start of its entry day; its P&L joins the account at the end of the
    day of its last sale (BT_ACCT=entry: at the end of its entry day)."""
    eq, peak, dd = start, start, 0.0
    if ACCT == "entry":
        for d, rows in sorted(_by_day(T).items()):
            eq += sum(pct * eq * ret_at(r, pct) for r in rows)
            peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        return eq, dd
    by, held = _by_day(T), []   # held: [stake, row, marks {day: return so far}]
    def marks(r):
        st_ = [x.split(" ") for x in (r.get("steps") or "").split(";") if x]
        out = {}
        for x in st_:
            if len(x) >= 5 and x[2] == "carry":
                sold = sum(float(y[3]) * float(y[4].lstrip("@")) for y in st_ if len(y) >= 5 and y[2] == "sell" and y[0] <= x[0])
                out[x[0]] = (sold + float(x[3]) * float(x[4].lstrip("@"))) / r["cost"] - 1 if r.get("cost") else 0.0
        return out
    prev = None
    for d in sorted(set(by) | {exit_day(r) for r in T}):
        marked = sum(stake * m.get(prev, 0.0) for stake, _, m in held) if ACCT == "marked" else 0.0
        base = eq + marked
        for r in by.get(d, []): held.append([pct * base, r, marks(r) if ACCT == "marked" else {}])
        keep = []
        for stake, r, m in held:
            if exit_day(r) == d: eq += stake * ret_at(r, pct)
            else: keep.append([stake, r, m])
        held = keep
        now = eq + (sum(stake * m.get(d, 0.0) for stake, _, m in held) if ACCT == "marked" else 0.0)
        peak = max(peak, now); dd = max(dd, 1 - now / peak); prev = d
    return eq + sum(stake * ret_at(r, pct) for stake, r, _ in held), dd


def _by_day(T):
    by = collections.defaultdict(list)
    for r in T: by[r["date"]].append(r)
    return by


def summary(A, Z, names):
    import sim
    money = lambda v: f"{'-' if v < 0 else '+'}${abs(v):,.0f}"
    for name in names:
        W = json.load(open(f"{B}/list_{name}_{A}_{Z}.json"))
        T = [r for r in W if r["status"] == "bought" and r["ret"] is not None]
        status = collections.Counter(r["status"].split(":")[0] for r in W)
        print(f"\n## {name}: {A} to {Z}, {len(set(r['sym'] for r in W))} stocks with a signal")
        print(f"signals {len(W)} | skipped by the news filter {status['skipped']} | no contract {status['no contract']} | no fill {status['no fill']} | bought {status['bought']}")
        if not T: continue
        rets = [r["ret"] for r in T]
        wins = [x for x in rets if x > 0]
        nights = sum(any(not s.startswith(r["date"]) for s in r["steps"].split(";")) for r in T)
        print(f"trades {len(T)} | per trade at $10K {money(st.fmean(rets) * 10_000)} | winners {len(wins)} ({100 * len(wins) / len(T):.0f}%) | median {st.median(rets):+.0%} | held overnight {nights}")
        for pct in (0.01, 0.02):
            eq, dd = account(T, pct)
            cap = f", overnight capped at {sim.NIGHT_CAP:.0%} of the account" if sim.NIGHT_CAP and (pct <= 0.01 or "ret_2pct" in T[0]) else ""
            print(f"account at {pct:.0%} a trade: ${eq:,.0f} ({eq / 100_000 - 1:+.0%}), worst drop {dd:.0%}{cap}")
        top = sorted(T, key=lambda r: -r["ret"])[:5]
        print("best 5: " + ", ".join(f"{r['sym']} {r['date']} {r['ret']:+.0%}" for r in top))
        rest = [r["ret"] for r in T if r not in top]
        if rest: print(f"without the best 5: per trade {money(st.fmean(rest) * 10_000)}, account at 1% ${account([r for r in T if r not in top], 0.01)[0]:,.0f}")
        print("\n| Stock | Trades | Winners | Per trade at $10K | Best |\n|---|---|---|---|---|")
        by = collections.defaultdict(list)
        for r in T: by[r["sym"]].append(r["ret"])
        for s, v in sorted(by.items(), key=lambda kv: -sum(kv[1])):
            print(f"| {s} | {len(v)} | {sum(x > 0 for x in v)} | {money(st.fmean(v) * 10_000)} | {max(v):+.0%} |")


if __name__ == "__main__":
    mode, A, Z = sys.argv[1:4]
    if mode == "run": run(A, Z, sys.argv[4], [s.strip().upper() for s in sys.argv[5].split(",") if s.strip()])
    else: summary(A, Z, sys.argv[4:])
