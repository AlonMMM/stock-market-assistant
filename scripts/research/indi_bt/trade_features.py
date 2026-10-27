"""What each leg_seconds trade looked like at the buy, for the trade-filter scan (2026-10-27, the user: "too many trades,
maybe we are not filtering enough for the direction"). Only facts known at the buy second.
  FT_IN=<dumped trades> SEC_TAG=3y50 python3 trade_features.py > features.json"""
import csv, gzip, json, os, statistics as st, sys
os.environ.setdefault("BT_VARIANT", "v2")
import leg_seconds as LS
from store import day, calendar
CAL = calendar(); IDX = {d: i for i, d in enumerate(CAL)}
t15 = set(json.load(open(os.path.join(LS.HERE, "strangle_rank.json")))[:15])
ev = json.load(open(os.path.join(LS.OUT, f"events{LS.TAG}.json"))); pk = json.load(open(os.path.join(LS.OUT, f"picks{LS.TAG}.json")))
at = {(e["date"], e["sym"], e["m"]): i for i, e in enumerate(ev)}
out = []
for r in json.load(open(os.environ["FT_IN"])):
    i = at[(r["date"], r["sym"], r["minute"])]; e = ev[i]
    sec, side, spot = pk[i]["t"]["cross"]; contract = pk[i]["p"]["cross|plain20"][0]
    sg = 1 if side == "C" else -1
    bars = day(e["sym"], e["date"]); b = {x[0]: x for x in bars}; m = e["m"]
    upto = [x for x in bars if x[0] <= m]
    prev = [b[k][5] for k in range(max(0, m - 30), m) if k in b]
    hi, lo = max(x[2] for x in upto), min(x[3] for x in upto)
    spy = {x[0]: x for x in day("SPY", e["date"])}
    p2 = os.path.join(LS.OUT, "opt2", f"{e['date']}_{contract}_{sec}.csv.gz")
    spread = None
    if os.path.exists(p2):
        rows = [x for x in csv.reader(gzip.open(p2, "rt")) if int(x[0]) <= sec + LS.LAG and float(x[1]) > 0]
        if rows: bid, ask = float(rows[-1][1]), float(rows[-1][2]); spread = (ask - bid) / ((ask + bid) / 2)
    pday = day(e["sym"], CAL[IDX[e["date"]] - 1]) if IDX.get(e["date"], 0) > 0 else []
    out.append(dict(
        date=r["date"], sym=r["sym"], ret=(r["sell"] * 100 - 0.62) / (r["buy"] * 100 + 0.62) - 1, pnl=r["pnl"],
        minute=m, top15=int(r["sym"] in t15), call=int(side == "C"), dte1=int(e.get("kind") == "1"),
        to_cross=sec - (m + 1) * 60, s30=e["u"], price=r["buy"], spread=spread, delta=r["delta"],
        t=r["t"], d2=r["d2"], mv_open=r["mv_open"], mv_close=r["mv_close"],
        alert_vol=(b[m][5] / st.mean(prev)) if prev and st.mean(prev) > 0 and m in b else None,
        alert_move=sg * (b[m][4] / b[m - 3][4] - 1) / e["u"] if m in b and m - 3 in b else None,
        range_pos=((spot - lo) / (hi - lo) if side == "C" else (hi - spot) / (hi - lo)) if hi > lo else None,
        spy_move=sg * (spy[m][4] / spy[m - 3][4] - 1) * 100 if m in spy and m - 3 in spy else None,
        gap=sg * (bars[0][1] / pday[-1][4] - 1) / e["u"] if bars and pday else None,
    ))
json.dump(out, sys.stdout)
