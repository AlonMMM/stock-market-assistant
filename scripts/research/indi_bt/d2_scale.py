"""D2 entries at half size, the other half added on the real signal (the user, 2026-10-25: "D2 entries at half size but
then increase (buy the next delta 0.15) if we hit the right direction and hit the real bot alert").

On 2.5 + cheap + the next strike for D2 (export_bench d25-cheap-adjd2, the bot of the drop study dd_reduce.py). A D2
entry (t < 1.8) buys half the usual size. When the same stock reaches the regular signal later that day (t >= 1.8 and
volume >= 1.5x, the same side: 2.4's entry, s_t18r15), the bot buys the other half: a fresh 0.15-delta contract picked at
that minute (the cheap fallback as usual), walked with the same exits from there. The t >= 1.8 entries are unchanged
(full size). Set before running:
  half       D2 entries at half size, no add (dd_reduce.py's row)
  add-open   the add when the first half is still held at that minute (any part of it)
  add-up     the add when the first half is still held and its option is above what it cost
  add-any    the add on the real signal even if the first half was already sold
Each leg's overnight cap at its own size. Fair list, Feb 2024 - Oct 2026, from $100,000 at 1%; the yardstick is a
smaller flat size with the same worst drop (dd_reduce.py).

  node --env-file=.env <dir>/run.mjs d2_scale.py      (from the repo root)
"""
import csv, glob, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import news_filter as nf
import sizing_sweep as sw
from store import day
from low_delta import HIS40, PRIOR

B = "data/local/x/bt"
BASE = "d25-cheap-adjd2"
eb.VERSIONS["leg2"] = ("the add", "s_t18r15", eb.VERSIONS[BASE][2], "cheap")  # 2.4's signal, the candidate's exits, the cheap fallback


def legs(job):
    slug, t = job
    r = eb.one((slug, t))
    if not r: return None
    row, path = r
    steps = [(a, int(b), c, float(d), float(e), f) for a, b, c, d, e, f in (s.split(",") for s in path["steps"].split(";"))]
    cost = float(path["cost"])
    return slug, (t["date"], t["sym"], t["right"]), dict(row, c_t=float(t["c_t"]), cost=cost, steps=steps,
                                                       r1=sim.result(cost, steps, 0.01), rh=sim.result(cost, steps, 0.005))


def load(prefix):
    T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    return [t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]]


def held_at(leg, minute):
    """Share of the first leg still held at `minute` of the entry day, and its option's last close / cost then."""
    sold = sum(s[3] for s in leg["steps"] if s[2] == "sell" and s[0] == leg["date"] and s[1] <= minute)
    bars = [b for b in day(leg["contract"], leg["date"]) if b[0] <= minute]
    up = bars[-1][4] / leg["cost"] - 1 if bars else None
    return 1 - sold, up


def account(T, field):
    eq, peak, dd, cur, start = 1e5, 1e5, 0.0, None, 1e5
    for d, pnl in T:
        if d != cur: cur, start = d, eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        eq += start * pnl
    return eq, max(dd, 1 - eq / max(peak, eq))


def main():
    cand, reg = load("sg_c12_15"), load("s_t18r15")
    with mp.Pool(6) as pool:
        R = [r for r in pool.map(legs, [(BASE, t) for t in cand] + [("leg2", t) for t in reg], chunksize=8) if r]
    first = {k: v for s, k, v in R if s == BASE}
    add = {k: v for s, k, v in R if s == "leg2"}
    rows = {}
    for mode in ("full", "half", "add-open", "add-up", "add-any"):
        out, n_add, add_sum = [], 0, []
        for k, a in first.items():
            if a["c_t"] >= 1.8 or mode == "full": out.append((a["date"], 0.01 * max(-1, a["r1"]), a)); continue
            pnl = 0.005 * max(-1, a["rh"])
            b = add.get(k)
            if mode != "half" and b and int(b["minute"]) > int(a["minute"]):
                share, up = held_at(a, int(b["minute"]))
                ok = mode == "add-any" or (share > 0 and (mode == "add-open" or (up is not None and up > 0)))
                if ok:
                    p2 = 0.005 * max(-1, b["rh"]); pnl += p2; n_add += 1; add_sum.append(p2)
            out.append((a["date"], pnl, a))
        out.sort(key=lambda x: (x[0], int(x[2]["minute"])))
        rows[mode] = (out, n_add, add_sum)
    flat = []
    for s in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0):
        e, d = account([(x[0], x[1] * s) for x in rows["full"][0]], "")
        flat.append((d, e))
    print(f"\n### {BASE}, fair list: D2 entries (t < 1.8) {sum(a['c_t'] < 1.8 for a in first.values())} of {len(first)}\n")
    print("| Version | Account at 1% | Worst drop | Flat size with the same drop | Edge over flat | Without the best 5 | Adds | The adds at $10K a full trade (without their best 5) |\n|---|---|---|---|---|---|---|---|")
    names = {"full": "base: D2 entries at full size", "half": "D2 entries at half size, no add", "add-open": "half + add on the real signal (first half still held)",
             "add-up": "half + add on the real signal (first half held and up)", "add-any": "half + add on the real signal (always)"}
    for mode, (out, n_add, add_sum) in rows.items():
        e, d = account([(x[0], x[1]) for x in out], "")
        top = sorted(range(len(out)), key=lambda i: -out[i][1])[:5]
        e5, _ = account([(x[0], x[1]) for i, x in enumerate(out) if i not in set(top)], "")
        f = sw.edge(flat, d, e)
        s_ = sorted((x / 0.005 * 1e4 for x in add_sum), reverse=True)  # each add is half a 1% trade: its return x $10K
        adds = f"{sum(s_) / 1e3:+,.0f}K ({sum(s_[5:]) / 1e3:+,.0f}K)" if s_ else ""
        print(f"| {names[mode]} | ${e:,.0f} | {d:.0%} | {'$%s' % format(round(f), ',') if f else 'beyond flat 0.5-1%'} | {f'{e / f - 1:+.0%}' if f else ''} | ${e5:,.0f} | {n_add} | {adds} |", flush=True)


if __name__ == "__main__":
    main()
