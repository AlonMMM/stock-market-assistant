"""Half size at 16:40, more if it works (the user, 2026-10-25: "what about entering in 16:40 - maybe half there too as it's
high variance, then increase on the next 0.15 delta if we are right and have more than 50% gain").

On the pyramid (d2_scale.py "pyramid + fallback-added trades at half size": 2.5 + cheap + the next strike for D2, D2
entries at full size with the add on the real signal, both fallbacks at half size). An entry at the bot's first minute
(minute 10 = 09:40 New York = 16:40 Israel) buys half its size. When that position's option closes +50% or more over
what it cost on the entry day while still held, the bot adds half a size more: a fresh 0.15-delta contract picked at that
minute (0.15 delta, $0.20, 200 contracts), walked with the same exits. One add; an opening D2 entry takes this add
instead of the real-signal one. Set before running:
  open-half         the first-minute entries at half size, no add
  open-half+50      ... and the add at +50% (the thesis)
  open-half+100     ... and the add at +100% (a neighbour)
  open15-half+50    the entries in the first five minutes (minutes 10-15) at half, the add at +50% (a neighbour)
Fair list, Feb 2024 - Oct 2026, from $100,000 at 1%, each leg's night cap at its own size.

  node --env-file=.env <dir>/run.mjs open_scale.py      (from the repo root)
"""
import multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import export_bench as eb
import d2_scale as ds
import sizing_sweep as sw
from store import day

eb.VERSIONS["gain_add"] = ("the add at a gain", "sg_c12_15", eb.VERSIONS[ds.BASE][2], None)


def gain_add(job):
    """The first entry-day bar where the leg, still held, closes >= +gain -> the add's walk (its result at half size)."""
    key, a, gain = job
    m0 = int(a["minute"])
    for b in day(a["contract"], a["date"]):
        if b[0] <= m0 or b[4] / a["cost"] - 1 < gain: continue
        share, _ = ds.held_at(a, b[0])
        if share <= 0: return key, gain, None
        sb = [x for x in day(a["sym"], a["date"]) if x[0] <= b[0]]
        if not sb: return key, gain, None
        picked, _ = sim.pick(a["sym"], a["date"], b[0], a["right"], sb[-1][4])
        if not picked: return key, gain, None
        t = dict(date=a["date"], sym=a["sym"], right=a["right"], minute=str(b[0]), time="", price=sb[-1][4], contract=picked[0],
                 expiry=picked[1], iv="", status="ok", c_t="0")
        r = eb.one(("gain_add", t))
        if not r: return key, gain, None
        steps = [(x, int(y), z, float(q), float(p), w) for x, y, z, q, p, w in (s.split(",") for s in r[1]["steps"].split(";"))]
        return key, gain, sim.result(float(r[1]["cost"]), steps, 0.005)
    return key, gain, None


def main():
    cand, reg = ds.load("sg_c12_15"), ds.load("s_t18r15")
    with mp.Pool(6) as pool:
        R = [r for r in pool.map(ds.legs, [(ds.BASE, t) for t in cand] + [("leg2", t) for t in reg], chunksize=8) if r]
    first = {k: v for s, k, v in R if s == ds.BASE}
    sig_add = {k: v for s, k, v in R if s == "leg2"}
    early = [(k, a, g) for k, a in first.items() if int(a["minute"]) <= 15 for g in (0.5, 1.0)]
    with mp.Pool(6) as pool: G = {(k, g): r for k, g, r in pool.map(gain_add, early, chunksize=2)}

    def pnl_of(k, a, mode):
        fb = a["added"] == 1
        opening = (mode.startswith("open15") and int(a["minute"]) <= 15) or (mode.startswith("open-") and int(a["minute"]) == 10)
        half = fb or opening
        p = 0.005 * max(-1, a["rh"]) if half else 0.01 * max(-1, a["r1"])
        if opening and mode != "base" and "+" in mode:
            g = 1.0 if mode.endswith("+100") else 0.5
            r = G.get((k, g))
            return p + (0.005 * max(-1, r) if r is not None else 0), r is not None
        if a["c_t"] < 1.8:  # the pyramid's add on the real signal (held and up)
            b = sig_add.get(k)
            if b and int(b["minute"]) > int(a["minute"]):
                share, up = ds.held_at(a, int(b["minute"]))
                if share > 0 and up is not None and up > 0: return p + 0.005 * max(-1, b["rh"]), False
        return p, False

    modes = {"base": "pyramid + fallback trades at half (today's best)", "open-half": "+ 16:40 entries at half, no add",
             "open-half+50": "+ 16:40 entries at half, add at +50%", "open-half+100": "+ 16:40 entries at half, add at +100%",
             "open15-half+50": "+ 16:40-16:45 entries at half, add at +50%"}
    flat = None
    print(f"\n16:40 entries (minute 10): {sum(int(a['minute']) == 10 for a in first.values())} of {len(first)}; minutes 10-15: {sum(int(a['minute']) <= 15 for a in first.values())}\n")
    print("| Version | 2024 / 2025 / 2026 at $10K | Account at 1% | Worst drop | Flat size with the same drop | Edge over flat | Without the best 5 | Gain adds |\n|---|---|---|---|---|---|---|---|")
    for mode, name in modes.items():
        out, n = [], 0
        for k, a in first.items():
            p, added = pnl_of(k, a, mode)
            out.append((a["date"], p, int(a["minute"]))); n += added
        out.sort()
        if flat is None:
            flat = [(ds.account([(x[0], x[1] * s) for x in out], "")[1], ds.account([(x[0], x[1] * s) for x in out], "")[0]) for s in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)]
        e, d = ds.account([(x[0], x[1]) for x in out], "")
        top = set(sorted(range(len(out)), key=lambda i: -out[i][1])[:5])
        e5, _ = ds.account([(x[0], x[1]) for i, x in enumerate(out) if i not in top], "")
        f = sw.edge(flat, d, e)
        yrs = " / ".join(f"{sum(x[1] for x in out if x[0][:4] == y) * 1e6 / 1e3:+,.0f}K" for y in ("2024", "2025", "2026"))
        print(f"| {name} | {yrs} | ${e:,.0f} | {d:.0%} | {'$%s' % format(round(f), ',') if f else ''} | {f'{e / f - 1:+.0%}' if f else ''} | ${e5:,.0f} | {n} |", flush=True)


if __name__ == "__main__":
    main()
