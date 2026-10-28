"""The Volume winner with the same-week (2-4 DTE) trades held the main bot's way (the user, 2026-10-28): a same-week
trade drops the stock give-back and holds to 15:50; there the main bot's night rule (params.json exit): carry only if the
option is up >= carry_min_gain (the champion's +50%), the stock is in the top carry_range_pos of the day's range the bet's
way, >= carry_min_dte days to expiry and not a Friday, else sell all at the bid. What goes into the night is worth at most
night_cap (10%) of the account, the rest sold at 15:50. Next morning at 09:40: a gap the bet's way >= gap_keep % sells
gap_sell_share and keeps the rest, else sells all; the rest meets the same 15:50 rule; expiry day out at 15:30.
The 0/1 DTE trades are the winner's as they are (leg_seconds.py STR_DUMP_ALL). One account, live limits.
  python3 week_carry.py fetch-day | fetch-next | run      (from the app repo root)
  env: WC_01, WC_W (the STR_DUMP_ALL files), SEC_TAG3 (3y50), SEC_TAGW (3y50w)"""
import csv, datetime as dt, gzip, json, os, sys
from concurrent.futures import ThreadPoolExecutor
os.environ.setdefault("BT_VARIANT", "v2")
import dbx_fetch as F
import leg_realspread as RS
import leg_twice as TW
import sim
from store import day, P

HERE = os.path.dirname(os.path.abspath(__file__))
X = dict(P["exit"])
GAIN = float(os.environ.get("WC_GAIN", "0.5"))   # the champion holds from +50% (best-algorithms.md, 2026-10-24)
EOD, MORNING, EXP_LAST = X["eod_minute"], X["morning_minute"], X["expiry_last_minute"]
LATE = os.path.join(HERE, "dbx_cache", "extra_late")   # minute books after 15:31 and on the carried days
CAL = TW.CAL
COMM = 0.62


def late_quotes(date):
    by = {}
    p = os.path.join(LATE, f"{date}.csv.gz")
    if os.path.exists(p):
        for r in csv.DictReader(gzip.open(p, "rt")):
            if r["bid"] and r["ask"] and float(r["ask"]) > 0: by.setdefault(r["contract"], []).append((int(r["minute"]), float(r["bid"]), float(r["ask"])))
    for v in by.values(): v.sort()
    return by


_late = {}
def quote(contract, date, minute):
    """The book at the end of the minute: the late file first, then the usual minute cache (leg_realspread)."""
    if date not in _late: _late.clear(); _late[date] = late_quotes(date)
    v = _late[date].get(contract)
    if v:
        import bisect
        i = bisect.bisect(v, (minute + 1, 1e9, 1e9)) - 1
        if i >= 0 and v[i][0] >= minute - 4: return v[i][1], v[i][2]
    return RS.quote(contract, date, minute)


def contracts(tag):
    ev = json.load(open(os.path.join(HERE, "sec_cache", f"events{tag}.json")))
    pk = json.load(open(os.path.join(HERE, "sec_cache", f"picks{tag}.json")))
    return {(e["date"], e["sym"], e["m"]): (p["p"]["cross|plain20"][0], e["nxt"]) for e, p in zip(ev, pk) if "cross|plain20" in p["p"]}


def week_trades():
    T = [t for t in json.load(open(os.environ["WC_W"])) if not t["news_skip"]]
    C = contracts(os.environ.get("SEC_TAGW", "3y50w"))
    for t in T: t["contract"], t["expiry"] = C[(t["date"], t["sym"], int(t["minute"]))]
    return T


def fetch(items, lo, hi):
    """cbbo-1m for {date: [contracts]} from minute lo to hi into extra_late (merging with what is there)."""
    os.makedirs(LATE, exist_ok=True)
    def one(item):
        date, cs = item
        path = os.path.join(LATE, f"{date}.csv.gz")
        old = [[r[k] for k in F.HEAD] for r in csv.DictReader(gzip.open(path, "rt"))] if os.path.exists(path) else []
        have = {(r[0], int(r[1]) // 30) for r in old}
        want = sorted(c for c in cs if (c, lo // 30) not in have)
        if not want: return
        rows = list(old)
        for r in F.get(want, "cbbo-1m", F.utc(date, lo), F.utc(date, hi)):
            if not r["bid_px_00"] or not r["ask_px_00"]: continue
            ts = F.datetime.fromisoformat(r["ts_recv"].replace("Z", "+00:00")).astimezone(F.NY)
            rows.append([r["symbol"].replace(" ", ""), ts.hour * 60 + ts.minute - 570, r["bid_px_00"], r["ask_px_00"], r["bid_sz_00"], r["ask_sz_00"]])
        F.save(path, F.HEAD, rows)
    with ThreadPoolExecutor(8) as ex: list(ex.map(one, sorted(items.items())))


def range_pos(sym, date, t, bet):
    bars = [b for b in day(sym, date) if b[0] <= t]
    if not bars: return None
    hi, lo, c = max(b[2] for b in bars), min(b[3] for b in bars), bars[-1][4]
    if hi <= lo: return None
    return (c - lo) / (hi - lo) if bet > 0 else (hi - c) / (hi - lo)


def walk(t):
    """-> legs [(date, minute, share, price, rule)] of the trade held the main bot's way; None when a quote is missing.
    `carry` legs (share 0) mark each night with the option's 15:50 mid, for the night cap."""
    bet = 1 if t["side"] == "C" else -1
    con, exp, buy = t["contract"], t["expiry"], float(t["buy"])
    legs, rem, d = [], 1.0, t["date"]
    k = 0
    while True:
        if k > 0:   # a carried day: the morning rule
            q = quote(con, d, MORNING)
            if not q: return None
            prev = CAL[CAL.index(d) - 1]
            sb, pb = day(t["sym"], d), day(t["sym"], prev)
            gap = bet * (sb[0][1] / pb[-1][4] - 1) * 100 if sb and pb else None
            if gap is not None and gap >= X["gap_keep"]:
                legs.append((d, MORNING, rem * X["gap_sell_share"], q[0], "morning_gap_keep")); rem -= rem * X["gap_sell_share"]
            else:
                legs.append((d, MORNING, rem, q[0], "morning_gap_against")); return legs
        if d == exp:   # expiry day: out at 15:30
            q = quote(con, d, EXP_LAST)
            if not q: return None
            legs.append((d, EXP_LAST, rem, q[0], "expiry_day")); return legs
        q = quote(con, d, EOD)
        if not q: return None
        mid = (q[0] + q[1]) / 2
        dte = (dt.date.fromisoformat(exp) - dt.date.fromisoformat(d)).days
        fri = dt.date.fromisoformat(d).weekday() == 4
        rp = range_pos(t["sym"], d, EOD, bet)
        nxt = CAL[CAL.index(d) + 1] if CAL.index(d) + 1 < len(CAL) else None
        if mid / buy - 1 >= GAIN and (rp or 0) >= X["carry_range_pos"] and dte >= X["carry_min_dte"] and not (fri and X["carry_no_friday"]) and nxt and nxt <= exp:
            legs.append((d, EOD, 0.0, mid, "eod_carry", q[0])); d = nxt; k += 1
            continue
        legs.append((d, EOD, rem, q[0], "eod_close")); return legs


def exit_min(t):
    """The trade's last minute on its entry day (390 when it is carried)."""
    return int(t["legs"][-1][1]) if t["legs"][-1][0] == t["date"] else 390


def pick_flat(trades):
    """leg_twice.pick "flat" per stock: in alert order, a trade only once the stock's last one is out, 2 at most."""
    out, by = [], {}
    for t in trades: by.setdefault(t["sym"], []).append(t)
    for L in by.values():
        busy, n = -1, 0
        for t in sorted(L, key=lambda t: int(t["minute"])):
            if int(t["ct"]) <= busy or n >= 2: continue
            out.append(t); busy = exit_min(t); n += 1
    return out


def account(trades, size, cap):
    """leg_daycap.account with multi-leg trades: each trade costs `size` % of the account at the start of its entry day
    (buy + commission), its legs sell shares of the contracts; at each night only `cap` of the account may be held, the
    excess sold at 15:50's bid. Live limits on the entry day: 7.5% day loss, 15 trades, 5 open, 2 a stock, one at a time.
    The whole P&L counts on the entry day (a carried trade's day is its entry day). -> end, worst drop, rows."""
    eq, rows, peak, dd = 1e5, [], 1e5, 0.0
    by_day = {}
    for t in trades: by_day.setdefault(t["date"], []).append(t)
    for d in sorted(by_day):
        start, done = eq, []   # (exit minute on the entry day, pnl)
        for t in sorted(pick_flat(by_day[d]), key=lambda t: (int(t["bm"]), int(t["minute"]))):
            bm = int(t["bm"])
            closed = sum(p for x, p in done if x < bm)
            if closed <= -0.075 * start or len(done) >= 15 or sum(1 for x, p in done if x >= bm) >= 5: continue
            buy = float(t["buy"]); q = int(size / 100 * start // (buy * 100))
            if q < 1: continue
            got, held = 0.0, float(q)
            for ld, lm, share, px, rule, *bid in t["legs"]:
                if rule == "eod_carry":   # the night cap at this night's mid; the excess sold at the 15:50 bid
                    room = cap * start / (px * 100)
                    if held > room:
                        got += (held - room) * bid[0] * 100; held = room
                    continue
                n = min(held, share * q)
                got += n * px * 100; held -= n
            pnl = got - q * buy * 100 - COMM * 2 * q
            xm = exit_min(t)
            done.append((xm, pnl))
            rows.append(dict(date=d, sym=t["sym"], side=t["side"], kind=t["kind"], buy=buy, q=q, pnl=pnl, ret=pnl / (q * buy * 100 + COMM * q),
                             nights=sum(1 for x in t["legs"] if x[4] == "eod_carry"), rule=t["legs"][-1][4]))
        for x, p in sorted(done): eq += p; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
    return eq, dd, rows


def main():
    step = sys.argv[1]
    W = week_trades()
    if step == "fetch-day":   # 15:29 .. 15:52 on the entry day, every same-week trade
        items = {}
        for t in W: items.setdefault(t["date"], set()).add(t["contract"])
        print(sum(len(v) for v in items.values()), "contract-days"); fetch(items, 359, 382); return
    if step == "fetch-next":   # the carried days, whole sessions, repeated until no new day is needed
        for _ in range(4):
            need = {}
            for t in W:
                legs = walk_partial(t)
                if legs: need.setdefault(legs, set()).add(t["contract"])
            if not need: break
            print(sum(len(v) for v in need.values()), "carried contract-days"); fetch(need, 0, 382)
        return
    if step == "run":
        C01 = [t for t in json.load(open(os.environ["WC_01"])) if not t["news_skip"]]
        for t in C01: t["kind"], t["legs"] = "01", [(t["date"], int(t["xm"]), 1.0, float(t["sell"]), "giveback")]
        miss = 0
        for t in W:
            t["kind"] = "w"; t["legs"] = walk(t)
            if not t["legs"]: miss += 1
        Wok = [t for t in W if t["legs"]]
        print(f"same-week trades {len(W)}, walked {len(Wok)}, missing quotes {miss}; carried {sum(1 for t in Wok if any(l[4] == 'eod_carry' for l in t['legs']))}")
        print("| Set | Size | Trades | Won | Avg | $100K becomes | Drop | Without best 5 | Tune / check avg | Check without 2025-10-10 | Nights held |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for name, S in (("0-1 DTE only (check: the winner)", C01), ("same-week only, held", Wok), ("both, one account", C01 + Wok)):
            for size in (1, 2, 3, 4, 5):
                end, dd, R = account(S, size, X["night_cap"])
                p = sorted(r["pnl"] for r in R)
                avg = lambda L: sum(L) / max(1, len(L))
                tune = avg([r["ret"] for r in R if r["date"] < "2025-07"]); chk = avg([r["ret"] for r in R if r["date"] >= "2025-07"])
                chk_wo = avg([r["ret"] for r in R if r["date"] >= "2025-07" and r["date"] != "2025-10-10"])
                print(f"| {name} | {size}% | {len(R)} | {sum(x > 0 for x in p)} | {100 * avg([r['ret'] for r in R]):+.1f}% | ${end:,.0f} | {100 * dd:.1f}% | ${sum(p[:-5]):,.0f} | "
                      f"{100 * tune:+.1f} / {100 * chk:+.1f} | {100 * chk_wo:+.1f} | {sum(r['nights'] for r in R)} |", flush=True)
                if size == 2 and name.startswith("both"):
                    json.dump(R, open(os.environ.get("WC_OUT", "/dev/null"), "w"))


def walk_partial(t):
    """The first carried day whose morning book is missing (to fetch), or None."""
    bet = 1 if t["side"] == "C" else -1
    d, buy, k = t["date"], float(t["buy"]), 0
    while True:
        if k > 0 and not quote(t["contract"], d, MORNING): return d
        if d == t["expiry"]: return None
        q = quote(t["contract"], d, EOD)
        if not q: return None if k == 0 else d
        mid = (q[0] + q[1]) / 2
        dte = (dt.date.fromisoformat(t["expiry"]) - dt.date.fromisoformat(d)).days
        fri = dt.date.fromisoformat(d).weekday() == 4
        rp = range_pos(t["sym"], d, EOD, bet)
        nxt = CAL[CAL.index(d) + 1] if CAL.index(d) + 1 < len(CAL) else None
        if mid / buy - 1 >= GAIN and (rp or 0) >= X["carry_range_pos"] and dte >= X["carry_min_dte"] and not (fri and X["carry_no_friday"]) and nxt and nxt <= t["expiry"]:
            d = nxt; k += 1; continue
        return None


if __name__ == "__main__": main()
