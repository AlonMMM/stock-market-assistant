"""Minute paths (stock close, option bid/ask) of chosen leg_seconds trades, for a chart. TP_IN = dumped trades, TP_PICK = date|sym|minute,..."""
import json, os, sys
os.environ.setdefault("BT_VARIANT", "v2")
import leg_realspread as RS
from store import day
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sec_cache")
tag = os.environ.get("SEC_TAG", "")
ev = json.load(open(os.path.join(OUT, f"events{tag}.json"))); pk = json.load(open(os.path.join(OUT, f"picks{tag}.json")))
R = json.load(open(os.environ["TP_IN"]))
res = []
for want in os.environ["TP_PICK"].split(","):
    d, s, m = want.split("|"); m = int(m)
    r = next(x for x in R if x["date"] == d and x["sym"] == s and x["minute"] == m)
    i = next(i for i, e in enumerate(ev) if e["date"] == d and e["sym"] == s and e["m"] == m)
    contract = pk[i]["p"]["cross|plain20"][0]
    bars = {b[0]: b for b in day(s, d)}
    path = []
    for k in range(m - 5, r["xm"] + 6):
        q = RS.quote(contract, d, k)
        path.append(dict(m=k, stock=bars[k][4] if k in bars else None, bid=q[0] if q else None, ask=q[1] if q else None))
    res.append(dict(trade=r, contract=contract, u=ev[i]["u"], path=path))
json.dump(res, sys.stdout)
