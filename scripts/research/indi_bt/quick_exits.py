"""Trades the give-back stopped within QE_MAX minutes: where the stock went next. QE_IN = dumped trades."""
import json, os, statistics as st
os.environ.setdefault("BT_VARIANT", "v2")
from store import day
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sec_cache")
ev = {(e["date"], e["sym"], e["m"]): e for e in json.load(open(os.path.join(OUT, "events3y50.json")))}
R = json.load(open(os.environ["QE_IN"])); MX = int(os.environ.get("QE_MAX", "2"))
rows = []
for r in R:
    if r["xm"] - r["ct"] > MX: continue
    e = ev[(r["date"], r["sym"], r["minute"])]; u = e["u"]; sg = 1 if r["side"] == "C" else -1
    b = {x[0]: x for x in day(r["sym"], r["date"])}
    path = [sg * (b[k][4] / r["stock_in"] - 1) / u for k in range(r["xm"], min(r["xm"] + 31, 361)) if k in b]
    alert = sg * (r["stock_in"] / e["stock0"] - 1) / u
    rng = [(b[k][2] - b[k][3]) / b[k][4] / u for k in range(r["ct"], r["xm"] + 1) if k in b]
    rows.append(dict(alert=alert, low=min(path), best30=max(path), end30=path[-1], rng=max(rng) if rng else None))
print(len(rows), "trades stopped within", MX, "min")
print("entry vs the alert price, S30 units (median):", round(st.median(r["alert"] for r in rows), 2))
print("biggest 1-minute high-low range while held (median):", round(st.median(r["rng"] for r in rows if r["rng"]), 2))
print("30 min after the buy, the stock vs the buy price: median", round(st.median(r["end30"] for r in rows), 2),
      "| back above the buy at some point:", f'{100 * sum(r["best30"] > 0 for r in rows) / len(rows):.0f}%',
      "| reached +1 S30 our way:", f'{100 * sum(r["best30"] >= 1 for r in rows) / len(rows):.0f}%')
