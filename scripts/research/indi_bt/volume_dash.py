"""The Volume bot dashboard's files (Bot vs Indi layout) from leg_seconds.py STR_DUMP_ALL dumps (every filtered trade
before the account, one file per version): each version is put through the live account (leg_twice.pick "flat", 2 a
stock; leg_daycap.account: 7.5% day loss, 15 trades, 5 open) at 1-5% a trade and under four fill prices: real (the
Databento book: buy at the mid + half to the ask with the chase, sell at the bid) and the mid +-2 / 5 / 10% (buy at the
mid + x, sell at the mid - x, never under $0.01), $0.62 commission each way in all.
  trades.csv  one row per version, fill, size and kept trade: price paid and got, contracts, P&L, the account after it
  info.csv    one row per trade (tkey): contract, alert, cross, burst, minutes, exit, the mids
  bars.csv    per trade: the stock and SPY each minute from 30 minutes before the alert to 30 after the sale, side lines
  paths.csv   per trade: the option's bid and ask each minute from the alert to 5 minutes after the sale
  VD_VERSIONS="win=<dump>,b0=<dump>,bench=<dump>" SEC_TAG=3y50 python3 volume_dash.py <out dir>   (from the app repo root)"""
import csv, json, os, sys
os.environ.setdefault("BT_VARIANT", "v2")
import leg_seconds as LS
import leg_realspread as RS
import leg_twice as TW
import leg_daycap as D
from store import day

HERE = os.path.dirname(os.path.abspath(__file__))
TOP15 = set(json.load(open(os.path.join(HERE, "strangle_rank.json")))[:15])
CLOSE_MIN = 360   # 15:30, the last sale
FILLS = {"real": None, "2": 0.02, "5": 0.05, "10": 0.10}


def clock(m):
    t = 9 * 60 + 30 + int(m)
    return f"{t // 60}:{t % 60:02d}"


def contracts(tag):
    """(date, sym, alert minute) -> (contract, expiry kind, alert second, S30, alert price, expiry)."""
    ev = json.load(open(os.path.join(LS.OUT, f"events{tag}.json")))
    pk = json.load(open(os.path.join(LS.OUT, f"picks{tag}.json")))
    out = {}
    for e, p in zip(ev, pk):
        c = p["p"].get("cross|plain20")
        if c: out[(e["date"], e["sym"], e["m"])] = (c[0], e["kind"], e.get("sec0", (e["m"] + 1) * 60), e["u"], e["stock0"], e["nxt"])
    return out


def tkey(r): return f"{r['date']}|{r['sym']}|{int(r['minute'])}|{int(r['xm'])}"   # the same alert exits at another minute in another version


def priced(T, fill):
    """The trades at a fill price: real keeps the book's prices; x buys at the mid + x and sells at the mid - x."""
    x = FILLS[fill]
    if x is None: return T
    return [dict(t, buy=t["mid_in"] * (1 + x), sell=max(t["mid_out"] * (1 - x), 0.01)) for t in T]


def kept(T, size, free=False):
    """leg_seconds.py's account: per stock and day the alerts in order, one at a time, 2 at most; then the live limits
    (free: no day-loss, trade or open limit)."""
    by = {}
    for t in T: by.setdefault((t["date"], t["sym"]), []).append(dict(minute=t["minute"], trade=t))
    # no limits as leg_seconds.py runs it: the stock's alerts in order, 2 at most, the second may overlap the first
    keep = [x["trade"] for evs in by.values() for x in TW.pick(dict(events=sorted(evs, key=lambda z: z["minute"])), "open" if free else "flat")[:2]]
    if free: return D.account(keep, size, 2)
    return D.account(keep, size, 2, loss=7.5, max_trades=15, max_open=5)


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    C = {}
    for tag in os.environ.get("VD_TAGS", LS.TAG).split(","): C.update(contracts(tag))   # every alert list the versions use
    trades, info = [], {}
    for slug, spec in (v.split("=") for v in os.environ["VD_VERSIONS"].split(",")):
        path, *flags = spec.split(":")   # "<dump>[:free]": no limits
        free = "free" in flags
        T = [t for t in json.load(open(path)) if not t["news_skip"]]
        for t in T: info.setdefault(tkey(t), t)
        for fill in FILLS:
            P = priced(T, fill)
            for size in (1, 2, 3, 4, 5):
                end, dd, R, _, _ = kept(P, size, free)
                acct, day_start = 100000.0, {}
                for n, r in enumerate(sorted(R, key=lambda r: (r["date"], int(r["xm"]), r["sym"])), 1):
                    buy, sell, pnl = float(r["buy"]), float(r["sell"]), float(r["pnl"])
                    day_start.setdefault(r["date"], acct)   # leg_daycap.account sizes on the account at the day's start
                    qty = int(size / 100 * day_start[r["date"]] // (buy * 100))
                    acct += pnl
                    trades.append(dict(key=f"{slug}|{fill}|{size}|{n}", version=slug, fill=fill, size=size, n=n, tkey=tkey(r), date=r["date"], sym=r["sym"],
                                       right=r["side"], buy=round(buy, 3), sell=round(sell, 3), qty=qty,
                                       ret=round((sell * 100 - 0.62) / (buy * 100 + 0.62) - 1, 4), pnl=round(pnl, 2), account=round(acct, 2)))
                if slug == "win" and size == 2: print(f"win {fill} 2%: {len(R)} trades, ${end:,.0f}, drop {100 * dd:.1f}%", flush=True)
    shown = {t["tkey"] for t in trades}
    rows = []
    for k, r in info.items():
        if k not in shown: continue
        ct, kind, a_sec, u, stock0, nxt = C.get((r["date"], r["sym"], int(r["minute"])), ("", "", (int(r["minute"]) + 1) * 60, None, None, ""))
        rows.append(dict(tkey=k, contract=ct, expiry=nxt, dte=kind, delta=round(abs(float(r["delta"] or 0)), 3), alert=clock(int(r["minute"]) + 1),
                         alert_sec=a_sec, cross_s=r["to_cross"], burst=None if r["am"] is None else round(float(r["am"]), 2),
                         buy_min=int(r["bm"]), exit_min=int(r["xm"]), held_min=int(r["xm"]) - int(r["bm"]),
                         mid_in=round(float(r["mid_in"]), 3), mid_out=round(float(r["mid_out"]), 3),
                         group="Top 15" if r["sym"] in TOP15 else "Names 16-50",
                         exit="15:30 close" if int(r["xm"]) >= CLOSE_MIN else "Gave back 0.75 × S30 from the best"))
    for name, data in (("trades.csv", trades), ("info.csv", rows)):
        with open(os.path.join(out_dir, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0])); w.writeheader(); w.writerows(data)
    bars, paths = [], []
    for r in rows:
        src = info[r["tkey"]]
        date, sym, m, xm = src["date"], src["sym"], int(src["minute"]), int(src["xm"])
        ct, kind, a_sec, u, stock0, nxt = C.get((date, sym, m), ("", "", (m + 1) * 60, None, None, ""))
        lo, hi = max(0, m - 30), min(389, xm + 30)
        sb = {b[0]: b[4] for b in day(sym, date)}
        spy = {b[0]: b[4] for b in day("SPY", date)}
        fmt = lambda v: "" if v is None else f"{v:.4g}" if v < 100 else f"{v:.2f}"
        bars.append(dict(tkey=r["tkey"], start=lo, stock=" ".join(fmt(sb.get(t)) for t in range(lo, hi + 1)),
                         spy=" ".join(fmt(spy.get(t)) for t in range(lo, hi + 1)), stock0=stock0, u=u,
                         line_up=None if not stock0 else round(stock0 * (1 + 0.25 * u), 4), line_dn=None if not stock0 else round(stock0 * (1 - 0.25 * u), 4),
                         cross_sec=a_sec + int(src["to_cross"]), stock_in=src.get("stock_in"), stock_out=src.get("stock_out")))
        if not ct: continue
        q = [RS.quote(ct, date, t) for t in range(m, min(389, xm + 5) + 1)]
        paths.append(dict(tkey=r["tkey"], contract=ct, start=m, bid=" ".join("" if not x else f"{x[0]:.2f}" for x in q),
                          ask=" ".join("" if not x else f"{x[1]:.2f}" for x in q)))
    for name, data in (("bars.csv", bars), ("paths.csv", paths)):
        with open(os.path.join(out_dir, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0])); w.writeheader(); w.writerows(data)
    print(len(trades), "trade rows,", len(rows), "trades,", len(paths), "paths")


if __name__ == "__main__": main()
