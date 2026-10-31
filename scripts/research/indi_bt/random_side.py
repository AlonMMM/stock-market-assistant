"""The random-side test of the Volume bot (the audit's control, the user 2026-10-31: "do #2").

Same alerts, same buy second, same exit rule, same account; only the side changes. Each trade of the audited live run
($782,861 = live_ask "[flat2] shock <= 30%, burst >= 0", 430 trades, STR_WALK_KEEP=1 STR_CHASE_NOFILL=ask) is
simulated again on the OTHER side: at the same trigger second, the same version's contract (plain20 / the shock's
step35) of the same expiry on the opposite right, bought on its real 1-second book, the give-back walked the other way,
sold at the bid of its real minute book. Then 200 seeds pick the side of every trade by a coin flip.

  node --env-file=.env <dir>/run.mjs random_side.py fetch   # picks + Databento books for the mirror contracts
  node --env-file=.env <dir>/run.mjs random_side.py run     # the accounts
RS_BASE: the dump of kept trades (default: the audited live run). RS_OUT: where the mirror books and results go.
"""
import os, sys, json, gzip, csv, random, statistics as st
os.environ.setdefault("SEC_FROM", "2024-02-01")
os.environ.setdefault("STR_NOSTOP_MIN", "30")
os.environ.setdefault("STR_WALK_KEEP", "1")
os.environ.setdefault("STR_CHASE_NOFILL", "ask")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import leg_seconds as LS
from leg_seconds import triggers, trade, fetch_opt, get, sec_of, OUT, candidates, C, sim, RS, D
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ.get("RS_BASE", "/private/tmp/claude-501/-Users-alonmo-Desktop-Personal-stock-market-assistant/"
                      "80c0c11f-aa64-4f1f-be80-704e3e37636c/scratchpad/vol/audit/live_ask/flat2_shock_30_burst_0.json")
RO = os.environ.get("RS_OUT", os.path.join(HERE, "data", "random_side"))
TAGS = {"": "3y50q", "3y50wq": "3y50wq", "3ycandq": "3ycandq", "3ycandwq": "3ycandwq", "3ycand5q": "3ycand5q",
        "3ycand5wq": "3ycand5wq", "e_shock15": "e_shock15"}
SPLIT = "2025-07"
MB = {}   # mirror minute books: contract|date -> [(minute, bid, ask)]


def events():
    idx = {}
    for src, tag in TAGS.items():
        for e in json.load(open(os.path.join(OUT, f"events{tag}.json"))):
            if src: e["src"] = src
            idx[(src, e["date"], e["sym"], e["m"])] = e
    return idx


def setup(t, ev):
    e = ev.get((t["src"], t["date"], t["sym"], t["minute"]))
    if not e: return None, "no event"
    shock = t["src"] == "e_shock15"
    entry, v = ("hold5", "step35") if shock else ("cross", "plain20")
    tg = triggers(e)[entry]
    if not tg or tg[0] != t["alert_sec"] + t["to_cross"] or tg[1] != t["side"]: return None, "trigger differs"
    return (e, entry, v, tg), None


def mirror_pick(e, v, tg):
    sec, side, spot = tg
    side2 = "P" if side == "C" else "C"
    cm = sec // 60 - 1
    if e["kind"] == "0": C.update(dte_min=0, dte_max=0, delta=0.35)
    else: C.update(dte_min=1, dte_max=5, delta=0.35)
    if e["kind"] in ("w", "l"):
        from datetime import datetime
        C.update(dte_min=0 if e["kind"] == "w" else 2, dte_max=(datetime.fromisoformat(e["nxt"]) - datetime.fromisoformat(e["date"])).days)
    sim.pick(e["sym"], e["date"], cm, side2, spot)   # loads the chain's bars into the cache
    cands = [c for c in candidates(e["sym"], e["date"], cm, side2, spot) if c[1] == e["nxt"]]
    c = RS.pick(cands, v, e["date"], cm) if cands else None
    return (c[0], abs(c[3]), (sec, side2, spot)) if c else None


def mb_path(): return os.path.join(RO, "mirror_minutes.json")


def fetch_minutes(contract, date, m0):
    import re
    m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", contract)
    text = get("OPRA.PILLAR", "cbbo-1m", m.group(1).ljust(6) + m.group(2), date, (m0 - 2) * 60, 362 * 60)
    rows = []
    for r in csv.DictReader(__import__("io").StringIO(text)):
        if r["bid_px_00"] and r["ask_px_00"] and float(r["ask_px_00"]) > 0:
            rows.append((sec_of(r["ts_recv"]) // 60, float(r["bid_px_00"]), float(r["ask_px_00"])))   # book as that minute began
    return rows


def patch_quote():
    orig = RS.quote
    import bisect
    def quote(contract, date, minute):
        q = orig(contract, date, minute)
        if q: return q
        v = MB.get(f"{contract}|{date}")
        if not v: return None
        i = bisect.bisect(v, (minute + 1, 1e9, 1e9)) - 1
        if i < 0 or v[i][0] < minute - 4: return None
        return v[i][1], v[i][2]
    RS.quote = quote
    LS.RS.quote = quote


def step_fetch():
    os.makedirs(RO, exist_ok=True)
    T = json.load(open(BASE)); ev = events()
    plan, why = [], {}
    for t in T:
        s, w = setup(t, ev)
        if not s: why[w] = why.get(w, 0) + 1; plan.append(None); continue
        e, entry, v, tg = s
        mp_ = mirror_pick(e, v, tg)
        if not mp_: why["no mirror contract"] = why.get("no mirror contract", 0) + 1
        plan.append(dict(i=len(plan), entry=entry, v=v, tg=list(tg), mirror=list(mp_) if mp_ else None))
    json.dump(plan, open(os.path.join(RO, "plan.json"), "w"))
    print(len(T), "trades;", sum(1 for p in plan if p and p["mirror"]), "mirrors;", why, flush=True)
    jobs = [(ev[(T[p["i"]]["src"], T[p["i"]]["date"], T[p["i"]]["sym"], T[p["i"]]["minute"])], p) for p in plan if p and p["mirror"]]
    with ThreadPoolExecutor(16) as ex: list(ex.map(lambda j: fetch_opt((j[0], j[1]["mirror"][0], j[1]["tg"][0])), jobs))
    have = json.load(open(mb_path())) if os.path.exists(mb_path()) else {}
    def one(j):
        e, p = j; k = f"{p['mirror'][0]}|{e['date']}"
        if k in have: return k, have[k]
        return k, fetch_minutes(p["mirror"][0], e["date"], p["tg"][0] // 60)
    with ThreadPoolExecutor(16) as ex: res = list(ex.map(one, jobs))
    have.update({k: v for k, v in res})
    json.dump(have, open(mb_path(), "w"))
    print("minute books:", len(have), "; empty:", sum(1 for v in have.values() if not v))


def acct(rows, limits):
    if limits: return D.account(rows, 2, 2, loss=7.5, max_trades=15, max_open=5)[0]
    return D.account(rows, 2, 2)[0]


def step_run():
    MB.update({k: [tuple(x) for x in v] for k, v in json.load(open(mb_path())).items()})
    patch_quote()
    T = json.load(open(BASE)); ev = events(); plan = json.load(open(os.path.join(RO, "plan.json")))
    real0 = D.account(T, 2, 2)[0]
    print(f"the dump through the account: ${real0:,.0f} (the log: $782,861), {len(T)} trades")
    pairs, lost = [], {}
    for t, p in zip(T, plan):
        if not p or not p["mirror"]: lost["no mirror"] = lost.get("no mirror", 0) + 1; continue
        e = ev[(t["src"], t["date"], t["sym"], t["minute"])]
        again = trade((e, p["entry"], p["v"], t["contract"], t["delta"], tuple(p["tg"])))
        if isinstance(again, list): again = again[0]
        if not again or abs(again["buy"] - t["buy"]) > 1e-9 or abs(again["sell"] - t["sell"]) > 1e-9:
            lost["re-run differs"] = lost.get("re-run differs", 0) + 1
        c, d, tg2 = p["mirror"]
        m = trade((e, p["entry"], p["v"], c, d, tuple(tg2)))
        if isinstance(m, list): m = m[0]
        if not m: lost["mirror no fill/quote"] = lost.get("mirror no fill/quote", 0) + 1; continue
        keys = ("date", "sym", "minute", "src")
        pairs.append((t, dict(m, **{k: t[k] for k in keys})))
    print(f"pairs: {len(pairs)} of {len(T)}; {lost}")
    ret = lambda r: (r["sell"] * 100 - 0.62) / (r["buy"] * 100 + 0.62) - 1
    views = [("all 3 years", lambda t: True), ("without 2025-10-10", lambda t: t["date"] != "2025-10-10"),
             (f"tune (to {SPLIT})", lambda t: t["date"] < SPLIT), (f"check ({SPLIT} on)", lambda t: t["date"] >= SPLIT),
             ("check without 2025-10-10", lambda t: t["date"] >= SPLIT and t["date"] != "2025-10-10")]
    out = {}
    for limits, alab in ((False, "flat2 (no limits)"), (True, "live limits")):
        print(f"\n### {alab}, 2% a trade, $100K, the {len(pairs)} paired trades\n")
        print("| View | Bot's side | Other side (all) | Random side: median | 10th-90th pct | Best random | Random >= bot |")
        print("|---|---|---|---|---|---|---|")
        for vname, keep in views:
            P = [(a, b) for a, b in pairs if keep(a)]
            bot = acct([a for a, b in P], limits); oth = acct([b for a, b in P], limits)
            rnd = []
            for seed in range(200):
                g = random.Random(seed)
                rnd.append(acct([a if g.random() < 0.5 else b for a, b in P], limits))
            rnd.sort()
            q = lambda f: rnd[int(f * (len(rnd) - 1))]
            ge = sum(x >= bot for x in rnd)
            print(f"| {vname} | ${bot:,.0f} | ${oth:,.0f} | ${q(0.5):,.0f} | ${q(0.1):,.0f} - ${q(0.9):,.0f} | ${rnd[-1]:,.0f} | {ge}/200 |", flush=True)
            out[f"{alab}|{vname}"] = dict(bot=bot, other=oth, rnd=rnd)
    a_r = [ret(a) for a, b in pairs]; b_r = [ret(b) for a, b in pairs]
    print("\n### Per trade (net of the fill and $0.62 a contract each way)\n")
    print("| Side | Trades | Won | Average | Median | Without the best 10 (avg) |")
    print("|---|---|---|---|---|---|")
    for lab, r in (("bot's side", a_r), ("other side", b_r)):
        s = sorted(r)
        print(f"| {lab} | {len(r)} | {100 * sum(x > 0 for x in r) / len(r):.0f}% | {100 * st.mean(r):+.1f}% | {100 * st.median(r):+.1f}% | {100 * st.mean(s[:-10]):+.1f}% |")
    both = [(x + y) / 2 for x, y in zip(a_r, b_r)]
    print(f"| both sides, half each (a strangle) | {len(both)} | {100 * sum(x > 0 for x in both) / len(both):.0f}% | {100 * st.mean(both):+.1f}% | {100 * st.median(both):+.1f}% | {100 * st.mean(sorted(both)[:-10]):+.1f}% |")
    diff = [x - y for x, y in zip(a_r, b_r)]
    sd = st.pstdev(diff)
    print(f"\nBot's side minus other side, a trade: {100 * st.mean(diff):+.1f} points (t {st.mean(diff) / (sd / len(diff) ** 0.5):.2f}); "
          f"median {100 * st.median(diff):+.1f}; without 2025-10-10: "
          f"{100 * st.mean([x - y for (a, b), x, y in zip(pairs, a_r, b_r) if a['date'] != '2025-10-10']):+.1f}")
    json.dump(dict(pairs=[[a, b] for a, b in pairs], out=out), open(os.path.join(RO, "result.json"), "w"), default=str)


if __name__ == "__main__":
    {"fetch": step_fetch, "run": step_run}[sys.argv[1]]()
