"""The trading service's risk manager (packages/trading/src/risk-manager.ts, Indi's own rules) over finished trade lists.

States from the account's daily closes: full (5% a trade, 7% a day at risk), brake (2% / 3%) 12.5% below the high or
after two days in a row at the daily limit, recovery (3% / 5%) once two-thirds of the fall is back, brake again when half
of that is given back, full at a new high. Risk = premium x the share lost by days to expiry (90-100% for 1-7 DTE).

Three ways the bot can meet it, each at 1% and 2% of the account a trade from $100,000:
  none      no risk manager
  refuse    today: the order goes at full size; the risk manager refuses what does not fit (the trade is skipped)
  reactive  the bot sizes the order down to what fits (never below a quarter of its size; else it skips)

  python3 risk_overlay.py lists <A> <Z> <name> [...]   (from the repo root)
  python3 risk_overlay.py champion
"""
import csv, datetime as dt, glob, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2"); os.environ.setdefault("BT_UNIVERSE", "wide")
from store import calendar

B = "data/local/x/bt"
LIMITS = {"full": (5, 7), "brake": (2, 3), "recovery": (3, 5)}
DRAWDOWN, RECOVER, GIVE_BACK, STOPS = 12.5, 2 / 3, 1 / 2, 2


def loss_share(dte):
    if dte >= 30: return 0.5
    if dte >= 6: return 0.7
    if dte >= 5: return 0.75
    if dte >= 4: return 0.8
    if dte >= 3: return 0.85
    if dte >= 2: return 0.9
    return 1.0


def account_state(closes):
    """A port of accountState(): the state after the last close."""
    days = [e for e in closes if e > 0]
    if not days: return "full"
    state, peak = "full", days[0]
    trough = high = last = peak
    stops = 0
    for i, e in enumerate(days):
        if i > 0:
            loss = (last - e) / last * 100
            stops = stops + 1 if loss >= LIMITS[state][1] else 0
        last = e
        if e >= peak:
            peak = trough = e; state = "full"; continue
        two = stops >= STOPS
        if state == "full":
            trough = e
            if (peak - e) / peak * 100 >= DRAWDOWN or two: state = "brake"; trough = min(trough, e)
        elif state == "brake":
            trough = min(trough, e)
            if e >= trough + RECOVER * (peak - trough): state = "recovery"; high = e
        else:
            high = max(high, e)
            if e <= high - GIVE_BACK * (high - trough) or two: state = "brake"; trough = min(trough, e)
    return state


def run(T, pct, mode, cal):
    """T sorted by (date, minute) with ret and dte. Returns the figures."""
    eq, start, cur = 1e5, 1e5, None
    closes, by_day = [], {}
    for t in T: by_day.setdefault(t["date"], []).append(t)
    days = [d for d in cal if T[0]["date"] <= d <= T[-1]["date"]]
    taken = refused = shrunk = 0; in_state = {"full": 0, "brake": 0, "recovery": 0}
    peak, dd = 1e5, 0.0
    for d in days:
        start = eq
        state = account_state(closes) if mode != "none" else "full"
        in_state[state] += 1
        for t in by_day.get(d, []):
            premium = pct * start
            if mode == "half" and state == "brake": premium = pct * start / 2  # the bot's rule (PR #130)
            if mode != "none":
                share = loss_share(int(t["dte"]))
                # the trader sizes the order and checks it against one equity read: the same base here
                trade_limit = start * LIMITS[state][0] / 100
                day_limit = start * LIMITS[state][1] / 100
                today_loss = max(0.0, start - eq)
                fits = min(trade_limit, day_limit - today_loss) / share
                if premium * share > trade_limit + 1e-9 or today_loss + premium * share > day_limit + 1e-9:
                    if mode in ("refuse", "half") or fits < 0.25 * premium: refused += 1; continue
                    premium = fits; shrunk += 1
            taken += 1
            eq += premium * max(-1.0, float(t["ret"]))
        closes.append(eq)
        peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
    return dict(taken=taken, refused=refused, shrunk=shrunk, end=eq, dd=dd, **in_state)


def table(title, T, cal):
    print(f"\n### {title}: {len(T)} trades\n\n| Size | Bot and risk manager | Trades taken | Refused | Sized down | Account | Worst drop | Days full / brake / recovery |\n|---|---|---|---|---|---|---|---|")
    for pct in (0.01, 0.02, 0.04):
        for mode, lab in (("none", "no risk manager"), ("refuse", "today: refused when over"), ("half", "PR #130: half size under the brake"), ("reactive", "reactive: sized to fit")):
            r = run(T, pct, mode, cal)
            print(f"| {pct:.0%} | {lab} | {r['taken']} | {r['refused']} | {r['shrunk']} | ${r['end']:,.0f} | {r['dd']:.0%} | {r['full']} / {r['brake']} / {r['recovery']} |")


def lists(A, Z, names):
    cal = calendar()
    for name in names:
        W = json.load(open(f"{B}/list_{name}_{A}_{Z}.json"))
        T = sorted((dict(r, dte=(dt.date.fromisoformat(r["expiry"]) - dt.date.fromisoformat(r["date"])).days) for r in W if r["status"] == "bought" and r["ret"] is not None),
                   key=lambda r: (r["date"], int(r["minute"])))
        table(f"{name}, {A} to {Z}", T, cal)


def champion():
    import news_filter as nf
    from low_delta import HIS40, PRIOR
    cal = calendar()
    T = sorted((t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"),
               key=lambda t: (t["date"], int(t["minute"])))
    nf.features(T)
    T = [dict(t, dte=(dt.date.fromisoformat(t["expiry"]) - dt.date.fromisoformat(t["date"])).days) for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)]
    table("champion, fair list 2024-26", [t for t in T if t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]], cal)
    table("champion, 151 unseen 2024-26", [t for t in T if t["sym"] not in HIS40], cal)


if __name__ == "__main__":
    if sys.argv[1] == "lists": lists(sys.argv[2], sys.argv[3], sys.argv[4:])
    else: champion()
