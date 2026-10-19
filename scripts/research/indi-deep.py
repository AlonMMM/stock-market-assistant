"""Trade-level table for the deeper study of the trader (all years in one file).

Per main-account option trade: contract, days to expiry, entry time and context, size, adds/trims,
P&L, and for trades held past the close: what was carried, the stock's gap next morning in the
bet direction, and what he did first the next day.

  cd data/local/x && python3 ../../scripts/research/indi-deep.py 2023 2024 2025 2026   -> deep/trades.csv
"""
import csv, json, sqlite3, sys, os, collections, datetime as dt
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
PROXY = {"SPXW": "SPY", "SPX": "SPY", "XSP": "SPY", "NDXP": "QQQ", "NDX": "QQQ", "RUT": "IWM", "RUTW": "IWM"}
num = lambda x: float(x) if x not in ("", None) else None


class Bars:
    def __init__(self, years):
        self.dbs = [sqlite3.connect(f"ultrawavetrader-{y}/bars.sqlite") for y in years if os.path.exists(f"ultrawavetrader-{y}/bars.sqlite")]
        self.cache = {}

    def day(self, sym, date):
        """Regular-session 1-min bars [(hh:mm, o, h, l, c)] and the pre-market bars."""
        k = (sym, date)
        if k not in self.cache:
            raw = None
            for db in self.dbs:
                r = db.execute("SELECT bars FROM bars WHERE symbol=? AND date=?", (sym, date)).fetchone()
                if r: raw = json.loads(r[0]); break
            reg, pre = [], []
            for t, o, h, l, c, *_ in raw or []:
                hm = dt.datetime.fromtimestamp(t, NY).strftime("%H:%M")
                (reg if "09:30" <= hm < "16:00" else pre if hm < "09:30" else []).append((hm, o, h, l, c))
            self.cache[k] = (reg, pre)
        return self.cache[k]

    def close(self, sym, date):
        reg, _ = self.day(sym, date)
        return reg[-1][4] if reg else None

    def open(self, sym, date):
        reg, _ = self.day(sym, date)
        return reg[0][1] if reg and reg[0][0] <= "09:35" else None

    def at(self, sym, date, hm):
        reg, _ = self.day(sym, date)
        p = [b for b in reg if b[0] <= hm]
        return p[-1][4] if p else None


def occ(und, expiry, strike, right):
    return f"{und}{expiry[2:4]}{expiry[5:7]}{expiry[8:10]}{right}{round(strike * 1000):08d}"


def main(years):
    B = Bars(years)
    feats = {}
    for y in years:
        for r in csv.DictReader(open(f"ultrawavetrader-{y}/features.csv")):
            if r["action"] == "open" and r["trade"] not in feats: feats[r["trade"]] = r
    out = []
    for y in years:
        by = collections.defaultdict(list)
        for r in csv.DictReader(open(f"ultrawavetrader-{y}/actions.csv")):
            if r["account"] == "silexx" and not r["contract"].endswith("S"): by[r["trade"]].append(r)
        for trade, S in by.items():
            pnl = next((float(s["realized_total"]) for s in reversed(S) if s["realized_total"]), None)
            if pnl is None: continue
            und, expiry, sr = S[0]["contract"].rsplit(" ", 2)
            strike, right = float(sr[:-1]), sr[-1]
            bet = 1 if right == "C" else -1
            o = next((s for s in S if s["action"] in ("open", "re-enter")), S[0])
            d0 = o["date"]
            dates = sorted({s["date"] for s in S if not s["action"].startswith("expired")})
            buys = [s for s in S if s["side"] == "B"]
            bq = sum(int(s["qty"]) for s in buys)
            cost = sum(int(s["qty"]) * float(s["avg_price"]) * 100 for s in buys)
            first_cost = int(o["qty"]) * float(o["avg_price"]) * 100 if o["side"] == "B" else None
            maxpos = max(int(float(s["position_after"] or 0)) for s in S)
            sym = PROXY.get(und, und)
            r = dict(trade=trade, year=y, und=und, right=right, strike=strike, expiry=expiry, date=d0, time=o["time_from"],
                     dte=(dt.date.fromisoformat(expiry) - dt.date.fromisoformat(d0)).days,
                     entry_price=float(o["avg_price"]), first_cost=round(first_cost or 0), cost=round(cost), contracts=bq, maxpos=maxpos,
                     adds=sum(s["action"] == "add" for s in S), trims=sum(s["action"] == "trim" for s in S),
                     reenters=sum(s["action"] == "re-enter" for s in S), expired=int(any(s["action"].startswith("expired") for s in S)),
                     pnl=round(pnl), ret=round(pnl / cost * 100, 1) if cost else None, days=len(dates), last_date=dates[-1] if dates else d0)
            f = feats.get(trade)
            if f:
                for k in ("gap", "ret_open", "ex_open", "ret_day", "range_pos", "vs_vwap", "beyond_prev", "rvol_day", "otm", "prem_pct", "ex15"):
                    r[k] = f[k]
            # stock at the entry day: close vs entry, prior close, open
            spot = B.at(sym, d0, (o["time_from"] or "16:00")[:5])
            c0 = B.close(sym, d0)
            r["stock_entry_to_close"] = round(bet * (c0 / spot - 1) * 100, 2) if spot and c0 else None
            # carried overnight: the position left after the last step of the entry day
            day0 = [s for s in S if s["date"] == d0]
            carry = int(float(day0[-1]["position_after"] or 0)) if day0 else 0
            r["carried"] = carry
            r["carried_share"] = round(carry / maxpos, 2) if maxpos else None
            r["day0_realized"] = round(sum(float(s["realized_step"] or 0) for s in day0))
            if carry > 0 and len(dates) > 1:
                d1 = dates[1]
                o1 = B.open(sym, d1)
                r["next_date"] = d1
                r["gap_bet"] = round(bet * (o1 / c0 - 1) * 100, 2) if o1 and c0 else None
                spy0, spy1 = B.close("SPY", d0), B.open("SPY", d1)
                r["spy_gap"] = round((spy1 / spy0 - 1) * 100, 2) if spy0 and spy1 else None
                n1 = [s for s in S if s["date"] == d1]
                fs = n1[0]
                r["next_first_action"] = fs["action"]
                r["next_first_time"] = fs["time_from"]
                r["next_first_share"] = round(int(fs["qty"]) / carry, 2) if fs["side"] == "S" else None
                r["next_first_price_vs_cost"] = round((float(fs["avg_price"]) / float(day0[-1]["avg_cost_after"]) - 1) * 100, 1) if day0[-1]["avg_cost_after"] and fs["avg_price"] else None
                # option close on day 0 vs his first price next day (from option bars, 2024+)
                oc = B.close(occ(und, expiry, strike, right), d0)
                r["opt_close0"] = oc
                r["next_first_vs_optclose"] = round((float(fs["avg_price"]) / oc - 1) * 100, 1) if oc else None
                r["overnight_pnl"] = round(pnl - r["day0_realized"])
                r["closed_next_day"] = int(int(float(n1[-1]["position_after"] or 0)) == 0)
            out.append(r)
    os.makedirs("deep", exist_ok=True)
    keys = list(dict.fromkeys(k for r in out for k in r))
    w = csv.DictWriter(open("deep/trades.csv", "w"), fieldnames=keys); w.writeheader(); w.writerows(out)
    print(len(out), "trades ->", "deep/trades.csv")


main(sys.argv[1:])
