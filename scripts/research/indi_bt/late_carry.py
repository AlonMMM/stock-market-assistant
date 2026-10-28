"""Late alerts on 2 DTE, held overnight (the user, 2026-10-28: "add 2dte for those who have less than 3 hours to the
close, even if they have 0dte or 1dte; also take the last half hour and hold overnight"). The winner's entry on alerts
from 13:00 (leg_seconds.py SEC_LATE: the nearest expiry 2-7 days out, tag 3y50late): the side within 15 s, the burst the
side's way >= 1.1, the buy on the second book. The exit: the stock's give-back (0.75 x S30 from its best, minute closes)
after a 30-minute grace; at 15:50 (or the minute after a later buy) the night:
  A  carry whatever is still open;
  B  the main bot's rule: up >= 50%, the stock in the top 10% of the day's range the bet's way, >= 2 days to expiry,
     not a Friday.
At most 10% of the account goes into the night. A carried day: 09:40 the gap rule (>= 0.5% the bet's way sells half,
else all), the rest under the give-back from its best since 09:40, the same night rule at 15:50; expiry day out at 15:30.
One account with the winner's 0 / 1 DTE trades (WC_01), live limits.
  python3 late_carry.py fetch-day | fetch-next | run       (from the app repo root)"""
import csv, datetime as dt, gzip, json, os, sys
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("SEC_TAG", "3y50late")
import leg_seconds as LS
import leg_twice as TW
import week_carry as WK
from store import day, P

X = dict(P["exit"])
CAL = TW.CAL
EOD, MORNING, EXP_LAST, GIVE, GRACE = X["eod_minute"], X["morning_minute"], X["expiry_last_minute"], 0.75, 30


def late_trades():
    """The late alerts that pass the winner's entry, with the buy on the second book (as leg_seconds.trade)."""
    import news_filter as nf
    ev = json.load(open(os.path.join(LS.OUT, f"events{LS.TAG}.json"))); pk = json.load(open(os.path.join(LS.OUT, f"picks{LS.TAG}.json")))
    out = []
    for e, p in zip(ev, pk):
        c, tg = p["p"].get("cross|plain20"), p["t"].get("cross")
        if not c or not tg: continue
        sec, side, spot = tg
        if sec - (e["m"] + 1) * 60 > 15: continue
        sb = {b[0]: b[4] for b in day(e["sym"], e["date"])}
        if e["m"] not in sb or e["m"] - 3 not in sb: continue
        am = (1 if side == "C" else -1) * (sb[e["m"]] / sb[e["m"] - 3] - 1) / e["u"]
        if am < 1.1: continue
        f = LS.opt_path(e, c[0], sec)
        if not os.path.exists(f): continue
        rows = [(int(a), b, x) for a, b, x in csv.reader(gzip.open(f, "rt")) if float(b) > 0 and float(x) > 0]
        rows = [r for r in rows if float(r[2]) - float(r[1]) <= 0.5 * (float(r[1]) + float(r[2])) / 2]   # no flickering book
        q = LS.book_at(rows, sec + LS.LAG)
        if not q: continue
        mid = (q[0] + q[1]) / 2; buy = mid + (q[1] - mid) / 2
        later = LS.book_at(rows, sec + LS.LAG + 10)
        if later and later[0] > buy: buy = min(later[1], buy * 1.1)
        out.append(dict(date=e["date"], sym=e["sym"], minute=e["m"], ct=sec // 60, bm=sec // 60, side=side, buy=buy, spot=spot,
                        u=e["u"], contract=c[0], expiry=e["nxt"], am=am, to_cross=sec - (e["m"] + 1) * 60))
    rows = [dict(date=d, sym=s, minute=0, right="C") for d, s in {(t["date"], t["sym"]) for t in out}]
    nf.features(rows)
    skip = {(r["date"], r["sym"]) for r in rows if r["e_next"] == 0 or (r["pre_rvol"] is not None and r["pre_rvol"] >= 4)}
    for t in out: t["news_skip"] = int((t["date"], t["sym"]) in skip)
    return [t for t in out if not t["news_skip"]]


def night_ok(t, d, minute, mid, bet, variant):
    nxt = CAL[CAL.index(d) + 1] if CAL.index(d) + 1 < len(CAL) else None
    if not nxt or nxt > t["expiry"] or d == t["expiry"]: return False
    if variant == "A": return True
    dte = (dt.date.fromisoformat(t["expiry"]) - dt.date.fromisoformat(d)).days
    fri = dt.date.fromisoformat(d).weekday() == 4
    rp = WK.range_pos(t["sym"], d, minute, bet)
    return mid / t["buy"] - 1 >= 0.5 and (rp or 0) >= X["carry_range_pos"] and dte >= X["carry_min_dte"] and not (fri and X["carry_no_friday"])


def walk(t, variant):
    """-> legs [(date, minute, share, price, rule[, bid])], or (None, the date and minute whose quote is missing)."""
    bet = 1 if t["side"] == "C" else -1
    con, legs, rem, d, k = t["contract"], [], 1.0, t["date"], 0
    while True:
        bars = {b[0]: b[4] for b in day(t["sym"], d)}
        if k == 0: start, best, grace = t["bm"], t["spot"], GRACE
        else:
            q = WK.quote(con, d, MORNING)
            if not q: return None, (d, MORNING)
            sb, pb = day(t["sym"], d), day(t["sym"], CAL[CAL.index(d) - 1])
            gap = bet * (sb[0][1] / pb[-1][4] - 1) * 100 if sb and pb else None
            if gap is not None and gap >= X["gap_keep"]:
                legs.append((d, MORNING, rem * X["gap_sell_share"], q[0], "morning_gap_keep")); rem -= rem * X["gap_sell_share"]
            else:
                legs.append((d, MORNING, rem, q[0], "morning_gap_against")); return legs, None
            start, best, grace = MORNING, bars.get(MORNING) or t["spot"], 0
        last = EXP_LAST if d == t["expiry"] else max(EOD, start + 1)
        for m in range(start + 1, min(last, 389) + 1):
            if m not in bars: continue
            best = max(best, bars[m]) if bet > 0 else min(best, bars[m])
            if m - start <= grace or m >= last: continue
            if abs(bars[m] / best - 1) >= GIVE * t["u"]:
                q = WK.quote(con, d, m)
                if not q: return None, (d, m)
                legs.append((d, m, rem, q[0], "giveback")); return legs, None
        m = min(last, 389)
        q = WK.quote(con, d, m)
        if not q: return None, (d, m)
        if d == t["expiry"]:
            legs.append((d, m, rem, q[0], "expiry_day")); return legs, None
        mid = (q[0] + q[1]) / 2
        if night_ok(t, d, m, mid, bet, variant):
            legs.append((d, m, 0.0, mid, "eod_carry", q[0])); d = CAL[CAL.index(d) + 1]; k += 1; continue
        legs.append((d, m, rem, q[0], "eod_close")); return legs, None


def main():
    step = sys.argv[1]
    L = late_trades()
    print(len(L), "late trades pass the entry", flush=True)
    if step == "fetch-day":   # the entry day to 15:52 (extra_quotes stops at 15:31)
        items = {}
        for t in L: items.setdefault(t["date"], set()).add(t["contract"])
        WK.fetch(items, 359, 392); return
    if step == "fetch-next":   # the carried days, whole sessions, until nothing is missing
        for _ in range(6):
            need = {}
            for t in L:
                for v in ("A", "B"):
                    legs, miss = walk(t, v)
                    if miss and miss[0] != t["date"]: need.setdefault(miss[0], set()).add(t["contract"])
            if not need: break
            print(sum(len(v) for v in need.values()), "carried contract-days", flush=True)
            WK.fetch(need, 0, 392)
        return
    C01 = [t for t in json.load(open(os.environ["WC_01"])) if not t["news_skip"]]
    for t in C01: t["legs"] = [(t["date"], int(t["xm"]), 1.0, float(t["sell"]), "giveback")]; t["kind"] = "01"
    print("| Set | Night | Size | Trades | Won | Avg | $100K becomes | Drop | Without best 5 | Tune / check | Check without 2025-10-10 | Late trades: n, avg, P&L | Nights |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    avg = lambda X_: sum(X_) / max(1, len(X_))
    for variant in ("A", "B"):
        W, miss = [], 0
        for t in L:
            legs, m = walk(t, variant)
            if not legs: miss += 1; continue
            W.append(dict(t, legs=legs, kind="late"))
        sets = (("0-1 DTE (the winner)", C01), ("late 2 DTE only", W), ("both", C01 + W)) if variant == "A" else (("late 2 DTE only", W), ("both", C01 + W))
        for name, S in sets:
            for size in (2, 3):
                end, dd, R = WK.account(S, size, X["night_cap"])
                p = sorted(r["pnl"] for r in R)
                late = [r for r in R if r["kind"] == "late"]
                tune = avg([r["ret"] for r in R if r["date"] < "2025-07"]); chk = avg([r["ret"] for r in R if r["date"] >= "2025-07"])
                cw = avg([r["ret"] for r in R if r["date"] >= "2025-07" and r["date"] != "2025-10-10"])
                print(f"| {name} | {variant if name != '0-1 DTE (the winner)' else '-'} | {size}% | {len(R)} | {sum(x > 0 for x in p)} | {100 * avg([r['ret'] for r in R]):+.1f}% | ${end:,.0f} | {100 * dd:.1f}% | ${sum(p[:-5]):,.0f} | "
                      f"{100 * tune:+.1f} / {100 * chk:+.1f} | {100 * cw:+.1f} | {len(late)}, {100 * avg([r['ret'] for r in late]):+.1f}%, ${sum(r['pnl'] for r in late):,.0f} | {sum(r['nights'] for r in R)} |", flush=True)
        print(f"(variant {variant}: {miss} late trades without a quote left out)", flush=True)


if __name__ == "__main__": main()
