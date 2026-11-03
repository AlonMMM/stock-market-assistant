"""The stock's volume against SPY's, on the 3-year twin (the user, 2026-11-03: "I want to test the other test anyway.
because if we will add more trade we can catch more gaint that can cover these looses"). The plan alert passes its volume
test also when the stock's 3-minute ratio >= 2 and the stock's ratio / SPY's ratio >= K (rvol_alert RV_REL_K /
RV_REL_FLOOR). Levels set before the run: K 4 and 6 (the live year: K 4 the best year, K 6 the tune pick).
The rule only adds alerts: each 1.1.0 plan list (3y50, 3y50w, 3ycand, 3ycandw, 3ycand5, 3ycand5w) is rebuilt with the
rule on, over the same stocks, kinds and days, and its new alerts (not in the 1.1.0 list) go to a new tag <tag>r<K>
that leg_seconds.py runs as one more SEC_ADD_TAG. With RV_REL_K unset the rebuild must give the 1.1.0 list back.
  RV_REL_K=4 node --env-file=.env <dir>/run.mjs volume_rel_spy_3y.py list <tag>      (from the app repo root)
"""
import json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
os.environ.setdefault("SEC_FROM", "2024-02-01")
import leg_seconds as LS
import leg_1dte as L1
import week_count as WC
from zero5 import SPAN

# The 1.1.0 lists: their stocks come from the list itself; the burst prefilter and the kinds as each was built.
AM = {"3y50": None, "3y50w": "1.1", "3ycand": "1.1", "3ycandw": "2.5", "3ycand5": "1.1", "3ycand5w": "2.5"}


def jobs(tag, base):
    syms = sorted({e["sym"] for e in base})
    last = max(e["date"] for e in base)
    if tag.endswith("w"):   # SEC_WEEK: no 0/1 DTE but an expiry later that week, to the list's last day
        pairs = [(s, d) for s in syms for i, d in enumerate(LS.CAL) if LS.FROM <= d <= last and i >= 21]
        with mp.Pool(8) as pool: kinds = pool.map(WC.kind, pairs, chunksize=16)
        return [(d, s, "w") for (s, d), k in zip(pairs, kinds) if k == "w"]
    pairs = [(s, d) for s in syms for i, d in enumerate(LS.CAL) if i >= 21 and any(a <= d <= b for a, b in SPAN.values())]
    with mp.Pool(8) as pool: ks = pool.starmap(L1.kind_of, pairs, chunksize=16)
    return [(d, s, k) for (s, d), k in zip(pairs, ks) if k]


def main():
    tag = sys.argv[2]
    if AM[tag]: os.environ["SEC_AM_PRE"] = AM[tag]
    else: os.environ.pop("SEC_AM_PRE", None)
    base = json.load(open(os.path.join(LS.OUT, f"events{tag}.json")))
    js = jobs(tag, base)
    with mp.Pool(8) as pool: res = pool.map(LS.events_of, js, chunksize=8)
    ev = [e for r in res for e in r]
    key = lambda e: (e["date"], e["sym"], e["kind"], e["m"])
    have = {key(e) for e in base}
    new = [e for e in ev if key(e) not in have]
    gone = len(have - {key(e) for e in ev})
    k = os.environ.get("RV_REL_K")
    print(f"{tag}: {len(js)} stock-days, rebuilt {len(ev)} alerts vs 1.1.0 {len(base)}; new {len(new)}, 1.1.0 alerts not rebuilt {gone}")
    if k:
        out = os.path.join(LS.OUT, f"events{tag}r{k.rstrip('0').rstrip('.')}.json")
        json.dump(new, open(out, "w")); print("wrote", out)


if __name__ == "__main__":
    main()
