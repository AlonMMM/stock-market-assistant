"""The direction scorecard's label (docs/research/volume-direction-plan.md): after each alert, which way the stock goes
1 x S30 first within 30 minutes (C up, P down, None neither), and how often the live side rule (the first 0.25 x S30
cross within 10 minutes, per second) names it. Top 50 alerts (sec_cache/events<SEC_TAG>.json, picks for the cross)."""
import json, os, statistics as st, collections
os.environ.setdefault("BT_VARIANT", "v2")
from store import day
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sec_cache")
TAG = os.environ.get("SEC_TAG", "3y50")
ev = json.load(open(os.path.join(OUT, f"events{TAG}.json"))); pk = json.load(open(os.path.join(OUT, f"picks{TAG}.json")))


def label(e, start, ref):
    b = {x[0]: x for x in day(e["sym"], e["date"])}
    for k in range(start, min(start + 30, 361)):
        if k not in b: continue
        up, dn = b[k][2] / ref - 1 >= e["u"], 1 - b[k][3] / ref >= e["u"]
        if up and dn: return "both"
        if up: return "C"
        if dn: return "P"
    return None


res = collections.Counter(); per_year = collections.defaultdict(collections.Counter)
for i, e in enumerate(ev):
    t = pk[i]["t"].get("cross")
    if not t: res["no side"] += 1; continue
    sec, side, spot = t
    lab = label(e, sec // 60 + 1, spot)   # from the minute after the buy, against the buy price
    k = "no 1 x S30 move" if lab is None else ("both in one minute" if lab == "both" else ("right" if lab == side else "wrong"))
    res[k] += 1; per_year[e["date"][:4]][k] += 1
print(dict(res))
r, w = res["right"], res["wrong"]
print(f"side right {r}, wrong {w}: {100 * r / (r + w):.1f}% right of the alerts that moved 1 x S30")
for y, c in sorted(per_year.items()): print(y, f"{100 * c['right'] / max(1, c['right'] + c['wrong']):.1f}% right", dict(c))
