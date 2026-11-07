"""On a falling day, a higher bar for a new entry (the user, 2026-11-07: "in a falling day (spy started in 0.75 and more)
we should be extra carefull and maybe raise thae bar. Both volume and t might be polluted by the volatillity of the
market", then "Go with all"). On e (be_ramp_R.pkl), 2%. Set before running:
  the falling day   E = SPY at least x under the prior close at the entry minute; G = SPY opened at least x under it
                    (the gap); x = 0.5% / 0.75% (the user's) / 1.0%
  the bar           T22: the signal's t at least 2.2 (the entry needs 1.8; D2 entries are under it); T26: 2.6;
                    V175: the volume ratio (c_rvol) at least 1.75 (no small tier); V25: at least 2.5; TV: T22 and V175
A skipped main leg takes its adds. Pick per bar on tune (min of fair, Favorites vs e); check for the picks only; the
picks' unseen 2022-23 (2.10's main legs, trades_v210x.csv, booked on the entry day). Drops booked (marked beside).

  node --env-file=.env <dir>/run.mjs spy_bar.py
"""
import csv, json, os, pickle, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import dd_base as DB
import spy_down as SD
import store
import floor_exception as fe
import fav_real as FR

BARS = {"T22": (2.2, 0), "T26": (2.6, 0), "V175": (0, 1.75), "V25": (0, 2.5), "TV": (2.2, 1.75)}
DAYS = {"E": SD.spy_day}
_open = {}


def spy_gap(d, minute):
    if d not in _open:
        b = store.day("SPY", d); SD.spy_day(d, 1)
        _open[d] = (b[0][1] / SD._prev[d] - 1) if b and SD._prev.get(d) else 0.0
    return _open[d]


DAYS["G"] = spy_gap
T = {}
for s in fe.fair_signals("sg_c12_15"): T[("fair", s["date"], s["sym"], s["right"], int(s["minute"]))] = float(s.get("c_t") or 0)
for s in FR.signals("25"): T[("fav", s["date"], s["sym"], s["right"], int(s["minute"]))] = float(s.get("c_t") or 0)
for y in ("2022", "2023"):
    for s in json.load(open(f"{DB.BR.B}/y{y}/signals.json")): T[("y", s["date"], s["sym"], s["right"], int(s["minute"]))] = float(s.get("c_t") or 0)
VERS = {"e": None}
for dk in ("E", "G"):
    for x in (0.005, 0.0075, 0.01):
        for bk in BARS: VERS[f"{dk}{x * 1000:g}-{bk}"] = (dk, x, bk)   # e.g. E7.5-T22


def ok(src, r_date, sym, right, minute, rvol, v):
    if v is None: return True
    dk, x, bk = v
    if DAYS[dk](r_date, minute) > -x: return True
    tmin, vmin = BARS[bk]
    t = T.get((src, r_date, sym, right, minute))
    if t is None: return True
    return t >= tmin and rvol >= vmin


def run(R, adds, part, src, a, v):
    E = DB.entries(R, adds, src, part, a, keep=lambda r: ok(src, r["date"], r["sym"], r["right"], r["minute"], r["rvol"], v))
    return SD.stats(E)


def y2223(v):
    out = {}
    for y in ("2022", "2023"):
        rows = [r for r in csv.DictReader(open(f"{DB.BR.B}/y{y}/trades_v210x.csv")) if r["kind"] == "main" and r["news_ok"] == "1"
                and ok("y", r["date"], r["sym"], r["right"], int(r["minute"]), float(r["rvol"] or 0), v)]
        eq, pk, dd, usd = 1e5, 1e5, 0.0, []
        for r in sorted(rows, key=lambda r: (r["date"], int(r["minute"]))):
            w = DB.SV.SIZEV["t3A-c5"](float(r["rvol"] or 0)); ret = max(-1, float(r["r2"]))
            eq += 0.02 * eq * w * ret; pk = max(pk, eq); dd = max(dd, 1 - eq / pk); usd.append((1e4 * w * ret, ret))
        out[y] = dict(n=len(rows), acct=round(eq), bdd=round(dd, 3), giants=sum(r >= 3 for _, r in usd), sum=round(sum(u for u, _ in usd)))
    return out


def line(name, s, b):
    return f"{s['mains']} · ${s['acct']:,} ({s['acct'] / b['acct']:.3f}) · **{s['bdd']:.1%}** ({s['dd']:.1%}) · {s['win']:.1%} · {s['g_n']} · {s['median']:+,}"


def main():
    R, adds = pickle.load(open(f"{DB.BR.B}/be_ramp_R.pkl", "rb"))
    out = {}
    LISTS = (("fair", ""), ("fav", DB.FR.A24))
    hdr = "| Version | Fair: trades · end (vs e) · **booked drop** (marked) · winners · giants · median | Favorites: the same |\n|---|---|---|"
    print("\n### Tune weeks, 2%\n\n" + hdr)
    for v, spec in VERS.items():
        for src, a in LISTS: out[f"tune|{src}|{v}"] = run(R, adds, "tune", src, a, spec)
        print(f"| {v} | {line(v, out[f'tune|fair|{v}'], out['tune|fair|e'])} | {line(v, out[f'tune|fav|{v}'], out['tune|fav|e'])} |", flush=True)
    picks = []
    for dk in ("E", "G"):
        for bk in BARS:
            names = [k for k, s in VERS.items() if s and s[0] == dk and s[2] == bk]
            best = max(names, key=lambda k: min(out[f"tune|{l}|{k}"]["acct"] / out[f"tune|{l}|e"]["acct"] for l, _ in LISTS))
            picks.append(best)
    print("\nPicks (tune, min of the two lists vs e):", ", ".join(f"🎯 {p}" for p in picks))
    for part in ("check", "all"):
        print(f"\n### {part.capitalize()} weeks, 2%, e and the picks\n\n" + hdr)
        for v in ["e"] + picks:
            for src, a in LISTS: out[f"{part}|{src}|{v}"] = run(R, adds, part, src, a, VERS[v])
            print(f"| {v} | {line(v, out[f'{part}|fair|{v}'], out[f'{part}|fair|e'])} | {line(v, out[f'{part}|fav|{v}'], out[f'{part}|fav|e'])} |", flush=True)
    print("\n### Unseen 2022 / 2023 (2.10's main legs, real quotes), the picks\n\n| Version | 2022: trades · giants · sum · end / booked drop | 2023: the same |\n|---|---|---|")
    for v in ["e"] + picks:
        y = y2223(VERS[v]); out[f"y2223|{v}"] = y
        print(f"| {v} | " + " | ".join(f"{y[k]['n']} · {y[k]['giants']} · {y[k]['sum']:+,} · ${y[k]['acct']:,} / {y[k]['bdd']:.1%}" for k in ("2022", "2023")) + " |", flush=True)
    passed = [p for p in picks if all(out[f"{pt}|{l}|{p}"]["acct"] > out[f"{pt}|{l}|e"]["acct"] and out[f"{pt}|{l}|{p}"]["bdd"] <= out[f"{pt}|{l}|e"]["bdd"]
                                      for pt in ("tune", "check") for l, _ in LISTS)]
    print("\nPass (more money and no larger booked drop than e, tune and check, both lists):", passed or "none")
    json.dump(out, open(f"{DB.BR.B}/spy_bar_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
