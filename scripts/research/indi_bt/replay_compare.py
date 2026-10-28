"""Live Main bot vs the replay of its own code (replay_days.sh), trade by trade, for the day and week reviews.
Matches on day, stock and side; for each: the entry minute (Israel time), the contract and price, the sales' reasons and
the result, and for a trade on one side only why the other side has none (the live skip reason from its feed).
The replay's option prices are the recorded 1-minute bar close +-2%, so a cent or a strike apart is the price model.

  python3 scripts/research/indi_bt/replay_compare.py <first> <last>      (from the main checkout's root)
  -> prints the table; data/local/x/review/replay/compare_<first>_<last>.json
"""
import json, os, re, sys

A, Z = sys.argv[1], sys.argv[2]
LIVE, OUT = "data/local/x/review/live", "data/local/x/review/replay"


def il(minute):  # session minute -> Israel clock (New York + 6 h; the same both seasons until the clocks change)
    m = minute + 570 + 360
    return f"{m // 60 % 24:02d}:{m % 60:02d}"


def result(p):
    """The position's return on what it paid; None while part of it is held."""
    sold = sum(s["qty"] for s in p["sales"])
    if not p["bought"] or sold < p["bought"] or any(s.get("price") is None for s in p["sales"]): return None
    got = sum(s["qty"] * s["price"] for s in p["sales"])
    return got / (p["bought"] * p["cost"]) - 1


def row(p):
    return dict(minute=p["entryMinute"], time=il(p["entryMinute"]), contract=p["contract"], cost=round(p["cost"], 2),
                qty=p["bought"], bonus=bool(p.get("bonus")), add=bool(p.get("addOf")), status=p["status"],
                sales=[s["reason"] for s in p["sales"]], ret=result(p))


live = json.load(open(f"{LIVE}/bot.json"))
feed = live.get("activity", [])
skips = {}
for e in feed:
    m = re.match(r"([A-Z.]+) (call|put)(?: pyramid)?: (.*)", e.get("text", ""))
    if e.get("kind") == "skip" and m: skips.setdefault(m.group(1), m.group(3))
L = {}
for p in live.get("positions", []):
    if A <= p["day"] <= Z and not p.get("dry"):
        L.setdefault((p["day"], p["symbol"], p["right"]), []).append(row(p))
R = {}
for f in sorted(os.listdir(OUT)):
    m = re.match(r"replay-(\d{4}-\d{2}-\d{2})\.md$", f)
    if not m or not (A <= m.group(1) <= Z): continue
    blk = re.search(r"## Bot positions\s*```\s*(\[.*?\])\s*```", open(f"{OUT}/{f}").read(), re.S)
    for p in json.loads(blk.group(1)) if blk else []:
        R.setdefault((p["day"], p["symbol"], p["right"]), []).append(row(p))

rows = []
for k in sorted(set(L) | set(R)):
    lv, rp = sorted(L.get(k, []), key=lambda x: x["minute"]), sorted(R.get(k, []), key=lambda x: x["minute"])
    l0, r0 = (lv or [None])[0], (rp or [None])[0]
    if l0 and r0:
        same = "same" if l0["contract"] == r0["contract"] else "other strike"
        match = f"{same}, {'same minute' if abs(l0['minute'] - r0['minute']) <= 1 else f'{r0['minute'] - l0['minute']:+d} min'}"
    elif l0: match = "live only"
    else: match = f"replay only (live: {skips.get(k[1], 'no signal or skip in the feed')})"
    adds = (len(rp) > 1, len(lv) > 1)
    if adds[0] != adds[1]: match += "; pyramid add only in the " + ("replay" if adds[0] else "live")
    rows.append(dict(day=k[0], symbol=k[1], right=k[2], live=lv, replay=rp, match=match))

pct = lambda x: "open" if x is None else f"{x * 100:+.0f}%"
strike = lambda c: f"{c[-9]} {int(c[-8:]) / 1000:g}"  # OCC: right, then the strike in thousandths
side = lambda x: "—" if not x else f"{x[0]['time']} {strike(x[0]['contract'])} @{x[0]['cost']:.2f} {pct(x[0]['ret'])} {'/'.join(x[0]['sales'])}"
print(f"{'day':10} {'stock':6} {'live':42} {'replay':42} match")
for r in rows: print(f"{r['day']:10} {r['symbol']:5}{r['right']} {side(r['live']):42} {side(r['replay']):42} {r['match']}")
n = sum(1 for r in rows if r["live"] and r["replay"])
print(f"{n} of {len(rows)} on both sides; live {sum(1 for r in rows if r['live'])}, replay {sum(1 for r in rows if r['replay'])}")
json.dump(rows, open(f"{OUT}/compare_{A}_{Z}.json", "w"), indent=1)
