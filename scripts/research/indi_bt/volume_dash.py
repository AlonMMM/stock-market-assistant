"""The Volume bot dashboard's files (Bot vs Indi layout) from leg_seconds.py dumps (STR_DUMP_DIR, one dir per version,
liveN_*_all.json per size): trades.csv (one row per version, size and trade, with the account after it), bars.csv (per
trade: the stock and SPY each minute from 30 minutes before the alert to 30 after the sale, the side lines) and paths.csv
(per trade: the option's bid and ask each minute from the alert to 5 minutes after the sale).
  VD_VERSIONS="win=<dir>,b0=<dir>,bench=<dir>" SEC_TAG=3y50 python3 volume_dash.py <out dir>   (from the app repo root)"""
import csv, json, os, sys
os.environ.setdefault("BT_VARIANT", "v2")
import leg_seconds as LS
import leg_realspread as RS
from store import day

HERE = os.path.dirname(os.path.abspath(__file__))
TOP15 = set(json.load(open(os.path.join(HERE, "strangle_rank.json")))[:15])
CLOSE_MIN = 360   # 15:30, the last sale


def clock(m):
    t = 9 * 60 + 30 + int(m)
    return f"{t // 60}:{t % 60:02d}"


def contracts(tags):
    """(date, sym, alert minute) -> (contract, expiry kind, alert second) from each tag's events and picks."""
    out = {}
    for tag in tags:
        ev = json.load(open(os.path.join(LS.OUT, f"events{tag}.json")))
        pk = json.load(open(os.path.join(LS.OUT, f"picks{tag}.json")))
        for e, p in zip(ev, pk):
            c = p["p"].get("cross|plain20")
            if c: out[(e["date"], e["sym"], e["m"])] = (c[0], e["kind"], e.get("sec0", (e["m"] + 1) * 60), e["u"], e["stock0"], e["nxt"])
    return out


def exit_words(r):
    if int(r["xm"]) >= CLOSE_MIN: return "15:30 close"
    return "Gave back 0.75 × S30 from the best"


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    tags = [LS.TAG] + [t for t in os.environ.get("VD_ADD_TAGS", "").split(",") if t]
    C = contracts(tags)
    versions = [v.split("=") for v in os.environ["VD_VERSIONS"].split(",")]
    trades, seen = [], {}
    for slug, d in versions:
        for f in sorted(os.listdir(d)):
            if not f.startswith("live") or "without" in f or not f.endswith("_all.json"): continue
            size = float(f.split("_")[0][4:])
            acct = 100000.0
            R = sorted(json.load(open(os.path.join(d, f))), key=lambda r: (r["date"], int(r["xm"]), r["sym"]))
            day_start = {}
            for n, r in enumerate(R, 1):
                day_start.setdefault(r["date"], acct)   # the account at the start of the trade's day sizes it (leg_daycap.account)
                qty = int(size / 100 * day_start[r["date"]] // (float(r["buy"]) * 100))
                k = (r["date"], r["sym"], int(r["minute"]))
                ct, kind, a_sec, u, stock0, nxt = C.get(k, ("", "", (int(r["minute"]) + 1) * 60, None, None, ""))
                buy, sell = float(r["buy"]), float(r["sell"])
                acct += float(r["pnl"])
                tkey = f"{r['date']}|{r['sym']}|{int(r['minute'])}|{int(r['xm'])}"   # the same alert can exit at another minute in another version
                seen[tkey] = (r, ct, a_sec, u, stock0)
                trades.append(dict(key=f"{slug}|{size:g}|{n}", version=slug, size=f"{size:g}", n=n, tkey=tkey, date=r["date"], sym=r["sym"],
                                   right=r["side"], contract=ct, expiry=nxt, dte=kind, delta=round(abs(float(r["delta"] or 0)), 3),
                                   alert=clock(int(r["minute"]) + 1), alert_sec=a_sec, cross_s=r["to_cross"],
                                   burst=None if r["am"] is None else round(float(r["am"]), 2), buy_min=int(r["bm"]), exit_min=int(r["xm"]),
                                   buy_time=clock(int(r["bm"])), exit_time=clock(int(r["xm"]) + 1), held_min=int(r["xm"]) - int(r["bm"]),
                                   buy=round(buy, 3), sell=round(sell, 3), ret=round((sell * 100 - 0.62) / (buy * 100 + 0.62) - 1, 4),
                                   qty=qty, pnl=round(float(r["pnl"]), 2), account=round(acct, 2),
                                   group="Top 15" if r["sym"] in TOP15 else "Names 16-50", exit=exit_words(r)))
    with open(os.path.join(out_dir, "trades.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(trades[0])); w.writeheader(); w.writerows(trades)
    bars, paths = [], []
    for tkey, (r, ct, a_sec, u, stock0) in seen.items():
        date, sym, m = r["date"], r["sym"], int(r["minute"])
        lo, hi = max(0, m - 30), min(389, int(r["xm"]) + 30)
        sb = {b[0]: b[4] for b in day(sym, date)}
        spy = {b[0]: b[4] for b in day("SPY", date)}
        fmt = lambda v: "" if v is None else f"{v:.4g}" if v < 100 else f"{v:.2f}"
        bars.append(dict(tkey=tkey, start=lo, stock=" ".join(fmt(sb.get(t)) for t in range(lo, hi + 1)),
                         spy=" ".join(fmt(spy.get(t)) for t in range(lo, hi + 1)), stock0=stock0, u=u,
                         line_up=None if not stock0 else round(stock0 * (1 + 0.25 * u), 4), line_dn=None if not stock0 else round(stock0 * (1 - 0.25 * u), 4),
                         cross_sec=a_sec + int(r["to_cross"]), stock_in=r.get("stock_in"), stock_out=r.get("stock_out")))
        if not ct: continue
        p0, p1 = m, min(389, int(r["xm"]) + 5)
        q = [RS.quote(ct, date, t) for t in range(p0, p1 + 1)]
        paths.append(dict(tkey=tkey, contract=ct, start=p0, bid=" ".join("" if not x else f"{x[0]:.2f}" for x in q),
                          ask=" ".join("" if not x else f"{x[1]:.2f}" for x in q)))
    for name, rows in (("bars.csv", bars), ("paths.csv", paths)):
        with open(os.path.join(out_dir, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(len(trades), "trade rows,", len(bars), "bars,", len(paths), "paths")


if __name__ == "__main__": main()
