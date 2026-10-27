"""Second-by-second pictures of chosen leg_seconds trades (the Volume bot explained on paper): the alert price, the side
lines, the cross, the buy, the trailing give-back line, the exit, and the option's bid/ask each minute.
  EX_IN=<dumped trades> EX_PICK="date|sym|minute,..." SEC_TAG=3y50 python3 explain_paths.py > out.json"""
import csv, gzip, json, os, sys
os.environ.setdefault("BT_VARIANT", "v2")
import leg_seconds as LS
import leg_realspread as RS
import leg_fallback as LF
from store import day
ev = json.load(open(os.path.join(LS.OUT, f"events{LS.TAG}.json"))); pk = json.load(open(os.path.join(LS.OUT, f"picks{LS.TAG}.json")))
R = json.load(open(os.environ["EX_IN"]))
out = []
for want in os.environ["EX_PICK"].split(","):
    d, s, m = want.split("|"); m = int(m)
    r = next(x for x in R if x["date"] == d and x["sym"] == s and x["minute"] == m)
    i = next(i for i, e in enumerate(ev) if e["date"] == d and e["sym"] == s and e["m"] == m)
    e = ev[i]; contract = pk[i]["p"]["cross|plain20"][0]; sec, side, spot = pk[i]["t"]["cross"]
    secs = [(int(a), float(b)) for a, b in csv.reader(gzip.open(LS.stock_path(e), "rt"))]
    bars = {b[0]: b for b in day(s, d)}
    sg = 1 if side == "C" else -1
    best, trail = spot, []
    for t in range(r["ct"] + 1, r["xm"] + 1):   # the walk: minute closes, best so far, the give-back line
        if t not in bars: continue
        c = bars[t][4]; best = max(best, c) if side == "C" else min(best, c)
        trail.append(dict(m=t, close=c, best=best, line=best * (1 - sg * LF.GIVE * e["u"])))
    opt = []
    for t in range(m - 1, min(r["xm"] + 6, 362)):
        q = RS.quote(contract, d, t)
        if q: opt.append(dict(m=t, bid=q[0], ask=q[1]))
    minute_close = [dict(m=t, close=bars[t][4]) for t in range(max(0, m - 10), min(r["xm"] + 16, 390)) if t in bars]
    out.append(dict(date=d, sym=s, side=side, contract=contract, alert_sec=(m + 1) * 60, alert_min=m, stock0=e["stock0"], u=e["u"],
                    line_up=e["stock0"] * (1 + 0.25 * e["u"]), line_dn=e["stock0"] * (1 - 0.25 * e["u"]), give=LF.GIVE,
                    cross_sec=sec, cross_px=spot, buy_sec=sec + LS.LAG, buy=r["buy"], mid_in=r["mid_in"], exit_min=r["xm"], sell=r["sell"],
                    pnl=r["pnl"], ret=(r["sell"] * 100 - 0.62) / (r["buy"] * 100 + 0.62) - 1,
                    secs=[(a, b) for a, b in secs if a <= sec + 180], minutes=minute_close, trail=trail, opt=opt))
json.dump(out, sys.stdout)
