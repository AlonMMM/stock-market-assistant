"""The bots' live trades against the backtest, for a day or a week (the user, 2026-10-26: "check the actual trading vs
what we would expect if we ran the test on that day/week ... say if the backtest would do them ... with graphs").

For each bot (the Indi bot and the Alert leg) over <first>..<last>:
  live      the trades the bot made (live_fetch.sh: fills, sale reasons, the option's bid / ask when recorded)
  backtest  what the research backtest buys on the same days and list (Indi: week.py's output, which must exist;
            Alert leg: leg_twice.one on the live Favorites, first alert + again when flat, 2 a stock a day)
  match     by day, stock and side: both / live only / backtest only, and why
  real      the paper account has no market maker, so its fills are worse than a real account's. Each live fill is
            priced again at the real market: the option's exchange prints within 60 s before and 120 s after the
            fill (their median), else the recorded bid / ask's mid, else the 1-minute bar's close
  re-walk   the backtest's exits walked on the live contract from the live entry minute (production 2.5 exits),
            to separate the pick and the fill from the exits
Charts per trade (the app's Trade story panels): the stock with SPY x beta, the volume, the option with the paid
price, the stop, the live and backtest fills and the real prints.

  scripts/research/indi_bt/live_fetch.sh                                     (the live records)
  node --env-file=.env <path>/run.mjs week.py <first> <last>                 (the Indi backtest)
  node --env-file=.env <path>/run.mjs live_review.py <first> <last>          (from the main checkout's root)
  -> data/local/x/review/<first>_<last>/review.json + *.png
"""
import datetime as dt, json, os, statistics as st, sys, urllib.parse
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
from store import fetch_bars, day, calendar, _get
from fetch_context import pre

A, Z = sys.argv[1], sys.argv[2]
LIVE = "data/local/x/review/live"
OUT = f"data/local/x/review/{A}_{Z}"
os.makedirs(OUT, exist_ok=True)
NY, IL = ZoneInfo("America/New_York"), ZoneInfo("Asia/Jerusalem")


def load(name):
    p = f"{LIVE}/{name}.json"
    return json.load(open(p)) if os.path.exists(p) else {}


BOT, LEG = load("bot"), load("strangle")
FAV = (BOT.get("favorites") or {}).get("tickers") or []
CORE = BOT.get("universe") or []
SYMS = sorted({"SPY", *CORE, *FAV})
start = (dt.date.fromisoformat(A) - dt.timedelta(days=45)).isoformat()
for i in range(0, len(SYMS), 50):
    fetch_bars("stocks", SYMS[i:i + 50], start, Z, key=f"review|{','.join(SYMS[i:i + 50])}|{start}|{Z}")
    pre(SYMS[i:i + 50], start, Z)

import sim
from tiers_round import H, NIGHT
from signals import beta
CAL = calendar()
DAYS = [d for d in CAL if A <= d <= Z]
CHAMP = {**sim.X, **H, **NIGHT, "thesis": {"t": 0.5}, "carry_min_gain": 0.5, "after_half": dict(out=-0.2)}


def ny(ms):
    return dt.datetime.fromtimestamp(ms / 1000, NY)


def minute_of(ms):
    t = ny(ms)
    return t.date().isoformat(), t.hour * 60 + t.minute - 570


def il_time(date, m):
    t = dt.datetime.fromisoformat(date).replace(tzinfo=NY) + dt.timedelta(minutes=570 + m)
    return t.astimezone(IL).strftime("%H:%M")


def iso_ms(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000


def prints(contract, ms, before=60, after=120):
    """The option's exchange prints around a moment: [(ms, price, size)]."""
    a = dt.datetime.fromtimestamp((ms - before * 1000) / 1000, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    b = dt.datetime.fromtimestamp((ms + after * 1000) / 1000, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    q = dict(symbols=contract, start=a, end=b, limit=1000)
    try: j = _get("https://data.alpaca.markets/v1beta1/options/trades?" + urllib.parse.urlencode(q))
    except Exception: return []
    return [(iso_ms(t["t"]), t["p"], t["s"]) for t in (j.get("trades") or {}).get(contract, [])]


def real_price(contract, ms, book=None):
    """The real market's price at a fill: the prints' median, else the book's mid, else the bar's close."""
    pr = prints(contract, ms)
    if pr: return round(st.median(p for _, p, _ in pr), 4), "prints", pr
    if book and book.get("bid") is not None and book.get("ask"): return round((book["bid"] + book["ask"]) / 2, 4), "book mid", []
    date, m = minute_of(ms)
    b = sim.last_bar(day(contract, date), m, 5)
    return (b[4], "bar close", []) if b else (None, "none", [])


def occ_parts(c):
    """SPCX261026C00157500 -> (SPCX, 2026-10-26, C, 157.5)."""
    root = c[:-15]
    return root, f"20{c[-15:-13]}-{c[-13:-11]}-{c[-11:-9]}", c[-9], int(c[-8:]) / 1000


def watched(date, sym):
    """Was the stock on the live bot's list that session: the core list or the last Favorites list received before
    the open (from the activity feed). None when the feed does not reach back that far."""
    if sym in CORE: return True
    open_ms = dt.datetime.fromisoformat(date).replace(tzinfo=NY, hour=9, minute=30).timestamp() * 1000
    got = [a for a in BOT.get("activity") or [] if a["at"] < open_ms and "Favorites list" in a["text"] and "(" in a["text"]]
    if not got: return None
    text = max(got, key=lambda a: a["at"])["text"]
    return sym in [s.strip() for s in text[text.index("(") + 1:text.rindex(")")].split(",")]


# ---- the Indi bot ----
def indi():
    wk = f"data/local/x/bt/week_{A}_{Z}.json"
    bt = json.load(open(wk)) if os.path.exists(wk) else []
    bt = [r for r in bt if A <= r["date"] <= Z]
    fills = {}
    for br in ("alpaca", "ibkr"):
        for t in load(f"trades_{br}").get("trades") or []:
            fills[(br, t["symbol"], t["openedAt"][:16])] = t
    trades = []
    for p in BOT.get("positions") or []:
        if not (A <= p["day"] <= Z) or p.get("dry") or not p.get("bought"): continue
        sym, exp, right, k = occ_parts(p["contract"])
        buy_ms = p["openedAt"]
        buy_real, buy_how, buy_pr = real_price(p["contract"], buy_ms, p.get("entryBook"))
        sales = []
        for s in p.get("sales") or []:
            if not s.get("price"): continue
            r, how, pr = real_price(p["contract"], s["at"], s.get("book"))
            sales.append(dict(at=s["at"], day=minute_of(s["at"])[0], minute=minute_of(s["at"])[1], qty=s["qty"], reason=s["reason"],
                              paper=s["price"], real=r, real_how=how, book=s.get("book"), prints=pr))
        sold = sum(s["qty"] for s in sales)
        paper_ret = sum(s["qty"] * s["paper"] for s in sales) / (sold * p["cost"]) - 1 if sold else None
        real_ret = None
        if sold and buy_real and all(s["real"] for s in sales):
            real_ret = sum(s["qty"] * s["real"] for s in sales) / (sold * buy_real) - 1
        m = next((r for r in bt if r["date"] == p["day"] and r["sym"] == sym and r["right"] == right), None)
        # the backtest's exits on the live contract, from the live entry minute
        sim.X.clear(); sim.X.update(CHAMP)
        cost, steps, _ = sim.walk(sym, p["day"], p["entryMinute"], right, p["contract"], exp, CAL)
        rewalk = None
        if cost is not None:
            rewalk = dict(cost=round(cost, 4), ret=round(sim.result(cost, steps, 0.02), 4),
                          steps=[(s[0], s[1], s[2], round(s[3], 2), round(s[4], 4), s[5]) for s in steps])
        trades.append(dict(bot="indi", day=p["day"], sym=sym, right=right, contract=p["contract"], strike=k, expiry=exp, version=p.get("version"),
                           qty=p["bought"], entry_minute=p["entryMinute"], entry_il=il_time(p["day"], p["entryMinute"]), entry_stock=p.get("entryStock"),
                           paper_buy=p["cost"], real_buy=buy_real, real_buy_how=buy_how, entry_book=p.get("entryBook"), buy_prints=buy_pr, buy_ms=buy_ms,
                           sales=sales, paper_ret=paper_ret, real_ret=real_ret,
                           paper_pnl=round(sum(s["qty"] * s["paper"] for s in sales) * 100 - sold * p["cost"] * 100, 2) if sold else None,
                           real_pnl=round(sum(s["qty"] * s["real"] for s in sales) * 100 - sold * buy_real * 100, 2) if real_ret is not None else None,
                           backtest=m, rewalk=rewalk))
    seen = {(t["day"], t["sym"], t["right"]) for t in trades}
    # the live signals and skips, from the activity feed (one line each)
    acts = [dict(at=a["at"], kind=a["kind"], text=a["text"], day=ny(a["at"]).date().isoformat()) for a in BOT.get("activity") or []
            if a["kind"] in ("signal", "skip") and A <= ny(a["at"]).date().isoformat() <= Z]
    bt_only = [dict(r, on_list=watched(r["date"], r["sym"])) for r in bt if r["status"] == "bought" and (r["date"], r["sym"], r["right"]) not in seen]
    bt_skips = [r for r in bt if r["status"] != "bought"]
    return dict(trades=trades, backtest=bt, backtest_only=bt_only, backtest_skips=bt_skips, live_feed=acts)


# ---- the Alert leg ----
def leg():
    import leg_twice as LT, leg_1dte as L1
    import news_filter as nf
    LT.CAL[:] = CAL; L1.CAL[:] = CAL
    nf.CAL[:] = CAL; nf.IDX.clear(); nf.IDX.update({d: i for i, d in enumerate(CAL)})
    syms = [s for s in FAV if s != "SPY"]
    rows = []
    for d in DAYS:
        for s in syms:
            if CAL.index(d) < 21: continue
            k = L1.kind_of(s, d)
            if not k: continue
            r = LT.one((d, s, k))
            if r: rows.append(dict(date=d, sym=s, minute=r["first_minute"], right="C", r=r, kind=k))
    nf.features(rows)
    bt = []
    for t in rows:
        news = "earnings reaction day" if t["e_next"] == 0 else (f"pre-market volume {t['pre_rvol']:.1f}x" if t["pre_rvol"] is not None and t["pre_rvol"] >= 4 else None)
        for e in LT.pick(t["r"], "flat")[:2]:
            x = e["trade"]
            bt.append(dict(date=t["date"], sym=t["sym"], kind=t["kind"], alert_minute=e["minute"], side_minute=x["ct"], right="C" if x["kept"] == "call" else "P",
                           contract=x["contract"], buy=round(x["buy"], 4), sell=round(x["sell"], 4), buy_minute=x["bm"], exit_minute=x["xm"],
                           ret=round(x["sell"] / x["buy"] - 1 - 2 * 0.62 / (x["buy"] * 100), 4), skipped=news,
                           unit=x["sd30"] / 100, stock_ref=x["stock0"], nth=len([b for b in bt if b["date"] == t["date"] and b["sym"] == t["sym"]]) + 1))
    trades = []
    for t in (LEG.get("trades") or []) + (LEG.get("open") or []):
        if not (A <= t["day"] <= Z) or t.get("dry") or not t.get("leg"): continue
        lg = t["leg"]
        buys = [o for o in lg["orders"] if o["side"] == "buy" and o.get("price")]
        sells = [o for o in lg["orders"] if o["side"] == "sell" and o.get("price")]
        if not buys: continue
        b = buys[0]
        rb, rb_how, rb_pr = real_price(lg["contract"], b["at"], b.get("book"))
        sales = []
        for o in sells:
            r, how, pr = real_price(lg["contract"], o["at"], o.get("book"))
            sales.append(dict(at=o["at"], day=minute_of(o["at"])[0], minute=minute_of(o["at"])[1], qty=o["qty"], reason=o["reason"], paper=o["price"],
                              real=r, real_how=how, book=o.get("book"), prints=pr))
        sold = sum(s["qty"] for s in sales)
        m = next((r for r in bt if r["date"] == t["day"] and r["sym"] == t["symbol"] and r["right"] == t["side"]), None)
        trades.append(dict(bot="leg", day=t["day"], sym=t["symbol"], right=t["side"], contract=lg["contract"], qty=lg["bought"], alert_minute=t["alertMinute"],
                           unit=t["unit"], stock_ref=t["stockRef"], side_minute=t.get("sideMinute"),
                           entry_minute=minute_of(b["at"])[1], entry_il=il_time(t["day"], minute_of(b["at"])[1]), paper_buy=lg["cost"], real_buy=rb, real_buy_how=rb_how,
                           entry_book=b.get("book"), buy_prints=rb_pr, buy_ms=b["at"], sales=sales, close_reason=t.get("closeReason"),
                           paper_ret=sum(s["qty"] * s["paper"] for s in sales) / (sold * lg["cost"]) - 1 if sold else None,
                           real_ret=sum(s["qty"] * s["real"] for s in sales) / (sold * rb) - 1 if sold and rb and all(s["real"] for s in sales) else None,
                           backtest=m))
    seen = {(t["day"], t["sym"], t["right"]) for t in trades}
    sigs = [s for s in LEG.get("signals") or [] if A <= s["day"] <= Z]
    return dict(trades=trades, backtest=bt, backtest_only=[r for r in bt if not r["skipped"] and (r["date"], r["sym"], r["right"]) not in seen],
                live_signals=sigs, events=[e for e in LEG.get("events") or [] if A <= ny(e["at"]).date().isoformat() <= Z])


# ---- charts ----
def chart(t, name):
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    sym, d0 = t["sym"], t["day"]
    last_day = max([s["day"] for s in t["sales"]] + [d0])
    days = [d for d in CAL if d0 <= d <= last_day]
    x0 = {d: i * 390 for i, d in enumerate(days)}
    sb = [(x0[d] + b[0], b) for d in days for b in day(sym, d)]
    spy = {x0[d] + b[0]: b[4] for d in days for b in day("SPY", d)}
    ob = [(x0[d] + b[0], b) for d in days for b in day(t["contract"], d)]
    if not sb: return None
    e = x0[d0] + t["entry_minute"]
    ref = next((b[4] for x, b in sb if x >= e), sb[0][1][4])
    sref = next((spy[x] for x in sorted(spy) if x >= e), None)
    try: bta = beta(sym, d0, CAL.index(d0), CAL) or 1.0
    except Exception: bta = 1.0
    fig, ax = plt.subplots(3, 1, figsize=(11, 8.2), sharex=True, gridspec_kw=dict(height_ratios=[3, 1, 2.4]))
    ax[0].plot([x for x, _ in sb], [b[4] for _, b in sb], color="#1f6feb", lw=1.3, label=sym)
    if sref:
        xs = sorted(spy)
        ax[0].plot(xs, [ref * (1 + bta * (spy[x] / sref - 1)) for x in xs], color="#9a9a9a", lw=1, ls="--", label=f"SPY × β {bta:.1f} (from the entry)")
    ax[1].bar([x for x, _ in sb], [b[5] for _, b in sb], width=1, color="#8b949e")
    if ob:
        ax[2].fill_between([x for x, _ in ob], [b[3] for _, b in ob], [b[2] for _, b in ob], color="#d0d7de", step="mid", label="option bar range")
        ax[2].plot([x for x, _ in ob], [b[4] for _, b in ob], color="#6e40c9", lw=1.2, label="option close")
    for a in ax: a.axvline(e, color="#1a7f37", lw=1.2)
    ax[2].scatter([e], [t["paper_buy"]], marker="^", s=90, color="#1a7f37", zorder=5, label=f"live buy {t['paper_buy']:.2f}")
    if t["real_buy"]: ax[2].scatter([e], [t["real_buy"]], marker="^", s=90, facecolors="none", edgecolors="#1a7f37", zorder=5, label=f"real price {t['real_buy']:.2f}")
    for s in t["sales"]:
        x = x0.get(s["day"], 0) + s["minute"]
        for a in ax: a.axvline(x, color="#cf222e", lw=1.2)
        ax[2].scatter([x], [s["paper"]], marker="v", s=90, color="#cf222e", zorder=5, label=f"live sell {s['paper']:.2f} ({s['reason']})")
        if s["real"]: ax[2].scatter([x], [s["real"]], marker="v", s=90, facecolors="none", edgecolors="#cf222e", zorder=5, label=f"real price {s['real']:.2f}")
    pr = [(p, q) for p, q in [(minute_of(ms), px) for ms, px, _ in t["buy_prints"] + [z for s in t["sales"] for z in s["prints"]]]]
    if pr:
        ax[2].scatter([x0.get(dd, 0) + mm for (dd, mm), _ in pr], [q for _, q in pr], s=8, color="#bf8700", zorder=4, label="exchange prints")
    if t["bot"] == "indi":
        ax[2].axhline(t["paper_buy"] * 0.7, color="#cf222e", lw=0.8, ls=":", label="−30% stop")
        rw = t.get("rewalk")
        if rw:
            for s in rw["steps"]:
                if s[2] == "sell" and s[0] in x0:
                    ax[2].scatter([x0[s[0]] + s[1]], [s[4]], marker="x", s=70, color="#57606a", zorder=6)
            ax[2].plot([], [], "x", color="#57606a", label=f"backtest exits on this contract ({rw['ret']:+.0%})")
        bt = t.get("backtest")
        if bt and bt.get("status") == "bought":
            for a in ax[:1]: a.axvline(x0[d0] + int(bt["minute"]), color="#1a7f37", lw=1, ls="--")
    else:
        bt = t.get("backtest")
        if bt:
            ax[2].scatter([x0[d0] + bt["buy_minute"], x0[d0] + bt["exit_minute"]], [bt["buy"], bt["sell"]], marker="x", s=70, color="#57606a", zorder=6,
                          label=f"backtest buy / sell ({bt['ret']:+.0%})")
    ticks = [x0[d] + m for d in days for m in range(0, 391, 60)]
    ax[2].set_xticks(ticks, [il_time(d, m) if m else f"{d[5:]}\n{il_time(d, m)}" for d in days for m in range(0, 391, 60)], fontsize=8)
    ax[0].set_title(f"{sym} · {t['contract']} · {d0} · {t['entry_il']} Israel", fontsize=11, loc="left")
    ax[0].legend(fontsize=8, loc="best"); ax[2].legend(fontsize=7, loc="best", ncol=2)
    ax[0].set_ylabel("stock $"); ax[1].set_ylabel("volume"); ax[2].set_ylabel("option $")
    for a in ax: a.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(f"{OUT}/{name}.png", dpi=110)
    plt.close(fig)
    return f"{name}.png"


def leg_chart(bt, live, name):
    """One Alert leg trade, step by step: the alert, the side levels (±0.25 S30 for 10 minutes), the buy, the best
    since the buy and the give-back line (0.75 S30) that ends it. bt: the backtest row, live: the live trade (either
    may be None)."""
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    src = live or bt
    d, sym, side = src["day"] if live else bt["date"], src["sym"], src["right"]
    u, ref, a = src["unit"], src["stock_ref"], src["alert_minute"]
    sb = {b[0]: b for b in day(sym, d)}
    if not sb or not u: return None
    contract = live["contract"] if live else bt["contract"]
    ob = {b[0]: b for b in day(contract, d)}
    sm = (live or {}).get("side_minute") or (bt or {}).get("side_minute") or a
    bm = live["entry_minute"] if live else bt["buy_minute"]
    xm = live["sales"][-1]["minute"] if live and live["sales"] else (bt or {}).get("exit_minute", 360)
    up = side == "C"
    lo, hi = max(0, a - 30), min(389, xm + 30)
    xs = [m for m in range(lo, hi + 1) if m in sb]
    best, bests, trig = sb.get(sm, sb[min(sb)])[4], [], []
    for m in range(sm, xm + 1):
        if m in sb: best = max(best, sb[m][4]) if up else min(best, sb[m][4])
        bests.append((m, best)); trig.append((m, best * (1 - 0.75 * u) if up else best * (1 + 0.75 * u)))
    fig, ax = plt.subplots(3, 1, figsize=(11, 8), sharex=True, gridspec_kw=dict(height_ratios=[3, 1, 2.2]))
    ax[0].plot(xs, [sb[m][4] for m in xs], color="#1f6feb", lw=1.4, label=sym)
    for lvl in (ref * (1 + 0.25 * u), ref * (1 - 0.25 * u)):
        ax[0].hlines(lvl, a, a + 10, color="#9a6700", lw=1.2, ls="--")
    ax[0].plot([], [], ls="--", color="#9a6700", label=f"side levels: ±0.25 × {u * 100:.2f}% (30-min move), 10 min")
    ax[0].plot([m for m, _ in bests], [b for _, b in bests], color="#1a7f37", lw=1, ls=":", label="best since the buy")
    ax[0].plot([m for m, _ in trig], [v for _, v in trig], color="#cf222e", lw=1, ls=":", label="exit: give back 0.75")
    ax[1].bar(xs, [sb[m][5] for m in xs], width=1, color="#8b949e")
    if a in sb: ax[1].bar([a], [sb[a][5]], width=1, color="#9a6700")
    ox = [m for m in xs if m in ob]
    ax[2].plot(ox, [ob[m][4] for m in ox], color="#6e40c9", lw=1.3, label=f"{contract} close")
    if live:
        ax[2].scatter([bm], [live["paper_buy"]], marker="^", s=90, color="#1a7f37", zorder=5, label=f"live buy {live['paper_buy']:.2f}")
        if live["real_buy"]: ax[2].scatter([bm], [live["real_buy"]], marker="^", s=90, facecolors="none", edgecolors="#1a7f37", zorder=5, label=f"real price {live['real_buy']:.2f}")
        for s in live["sales"]:
            ax[2].scatter([s["minute"]], [s["paper"]], marker="v", s=90, color="#cf222e", zorder=5, label=f"live sell {s['paper']:.2f} ({s['reason']})")
            if s["real"]: ax[2].scatter([s["minute"]], [s["real"]], marker="v", s=90, facecolors="none", edgecolors="#cf222e", zorder=5, label=f"real price {s['real']:.2f}")
    if bt:
        ax[2].scatter([bt["buy_minute"], bt["exit_minute"]], [bt["buy"], bt["sell"]], marker="x" if live else "o", s=70, color="#57606a" if live else "#1a7f37",
                      zorder=6, label=f"backtest buy {bt['buy']:.2f} / sell {bt['sell']:.2f} ({bt['ret']:+.0%})")
    for axx in ax:
        axx.axvline(a, color="#9a6700", lw=1); axx.axvline(bm, color="#1a7f37", lw=1); axx.axvline(xm, color="#cf222e", lw=1)
        axx.grid(alpha=.25)
    step = 15 if hi - lo <= 150 else 30
    ticks = [m for m in range(lo - lo % step, hi + 1, step) if m >= lo]
    ax[2].set_xticks(ticks, [il_time(d, m) for m in ticks], fontsize=8)
    tag = "LIVE" if live else ("BACKTEST · news skip: " + bt["skipped"] if bt.get("skipped") else "BACKTEST")
    ax[0].set_title(f"{tag} · Alert leg · {sym} {'Call' if up else 'Put'} · {d} · alert {il_time(d, a)} Israel", loc="left", fontsize=11)
    ax[0].legend(fontsize=8); ax[2].legend(fontsize=8)
    ax[0].set_ylabel("stock $"); ax[1].set_ylabel("volume"); ax[2].set_ylabel("option $")
    fig.tight_layout(); fig.savefig(f"{OUT}/{name}.png", dpi=110); plt.close(fig)
    return f"{name}.png"


def main():
    res = dict(first=A, last=Z, days=DAYS, indi=indi(), leg=leg(),
               settings=dict(indi=BOT.get("settings"), leg=LEG.get("settings")), version=BOT.get("version"))
    for t in res["indi"]["trades"]:
        t["chart"] = chart(t, f"indi_{t['day']}_{t['sym']}_{t['right']}")
    for t in res["leg"]["trades"]:
        t["chart"] = leg_chart(t["backtest"], t, f"leg_{t['day']}_{t['sym']}_{t['right']}_{t['alert_minute']}")
    for r in res["leg"]["backtest_only"]:
        r["chart"] = leg_chart(r, None, f"leg_bt_{r['date']}_{r['sym']}_{r['right']}_{r['alert_minute']}")
    json.dump(res, open(f"{OUT}/review.json", "w"), default=str, indent=1)
    for b in ("indi", "leg"):
        r = res[b]
        print(f"{b}: live {len(r['trades'])}, backtest {len([x for x in r['backtest'] if x.get('status', 'bought') == 'bought' and not x.get('skipped')])}, "
              f"backtest only {len(r['backtest_only'])}")
        for t in r["trades"]:
            m = t["backtest"]
            print(f"  {t['day']} {t['sym']} {t['right']} {t['entry_il']} paper {t['paper_ret'] if t['paper_ret'] is None else round(t['paper_ret'], 3)} "
                  f"real {t['real_ret'] if t['real_ret'] is None else round(t['real_ret'], 3)} buy {t['paper_buy']} vs {t['real_buy']} ({t['real_buy_how']}) "
                  f"backtest: {(m or {}).get('status', 'bought' if m else 'no signal')}")
    print(OUT)


if __name__ == "__main__":
    main()
