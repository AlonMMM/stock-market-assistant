"""The overnight cap, everywhere (the user, 2026-10-25: "I want 10% cap overnight ALWAYS and everywhere"): at 15:50 what is
held into the night is worth at most `night_cap` of the account (params.json exit, 0.10; BT_NIGHT_CAP overrides), the
excess sold at the close, as the live bot's nightCapPct. sim.result() applies it for the size it is asked for (sim.cap_steps),
so a stored walk needs no re-run: the cap is applied to its steps here.

  python3 night_cap.py lists        every data/local/x/bt/list_*.json: ret (1%, capped), ret_2pct, ret_nocap from its steps
  python3 night_cap.py viz          the Backtest Reports trades.csv (ret, ret_2pct, ret_nocap from paths*.csv) and the Bot vs
                                    Indi trades file (<trades.csv> <paths.csv> -> viz_lists/bvi_trades.csv, with ret_4pct, ret_5pct)
  node --env-file=.env <dir>/run.mjs night_cap.py walk     the champion (sg_c12_15, bot 2.5's exits) on the fair list and the
                                    151 unseen walked again -> night_cap_walk.json (steps)
  python3 night_cap.py report       the cap's cost: fair / unseen (walk), the Bot vs Indi versions, the favorites lists
"""
import csv, glob, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim

B = "data/local/x/bt"
VIZ = f"{B}/viz_lists"
WALK = f"{B}/night_cap_walk.json"
SIZES = {"ret": 0.01, "ret_2pct": 0.02, "ret_3pct": 0.03, "ret_4pct": 0.04, "ret_5pct": 0.05, "ret_nocap": 0}
BVI_SIZES = SIZES


def parse_list_steps(s):
    """lists.py's "date minute side share @price rule;..." (the buy left out) -> step tuples."""
    out = []
    for x in filter(None, s.split(";")):
        d, m, side, q, px, rule = x.split(" ")
        out.append((d, int(float(m)), side, float(q), float(px.lstrip("@")), rule))
    return out


def parse_path_steps(s):
    """The dashboards' "d,m,side,q,px,rule;..." (the buy included) -> step tuples."""
    out = []
    for x in filter(None, s.split(";")):
        d, m, side, q, px, rule = x.split(",")
        out.append((d, float(m), side, float(q), float(px), rule))
    return out


def rets(cost, steps, base, sizes=SIZES):
    """The stored return `base` (exact) moved by what the cap changes on the stored steps (lists.py and the dashboards keep
    them at 2 decimals, so the uncapped return recomputed from them is off by a little; the cap's effect is the difference)."""
    nocap = sim.result(cost, steps, 0)
    return {k: round(base + sim.result(cost, steps, pct) - nocap, 4) if pct else round(base, 4) for k, pct in sizes.items()}


def lists():
    for f in sorted(glob.glob(f"{B}/list_*.json")):
        W = json.load(open(f)); n = 0
        for r in W:
            if r.get("status") != "bought" or r.get("ret") is None or not r.get("steps"): continue
            if "ret_nocap" in r: r["ret"] = r["ret_nocap"]  # applied before: start from the stored uncapped return
            r.update(rets(float(r["cost"]), parse_list_steps(r["steps"]), float(r["ret"]))); n += 1
        json.dump(W, open(f, "w"), default=str, indent=1)
        print(f"{os.path.basename(f)}: {n} trades", flush=True)


def viz():
    paths = {}
    for f in glob.glob(f"{VIZ}/paths*.csv"):
        for p in csv.DictReader(open(f)): paths[p["key"]] = p
    T = list(csv.DictReader(open(f"{VIZ}/trades.csv")))
    for t in T:
        p = paths[t["key"]]
        base = float(t.get("ret_nocap") or t["ret"])
        t.update(rets(float(p["cost"]), parse_path_steps(p["steps"]), base))
    with open(f"{VIZ}/trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(T[0].keys())); w.writeheader(); w.writerows(T)
    print(f"Backtest Reports trades.csv: {len(T)} trades", flush=True)
    if len(sys.argv) > 3:
        T = list(csv.DictReader(open(sys.argv[2]))); paths = {p["key"]: p for p in csv.DictReader(open(sys.argv[3]))}
        for t in T:
            p = paths[t["key"]]
            base = float(t.get("ret_nocap") or t["ret"])
            t.update(rets(float(p["cost"]), parse_path_steps(p["steps"]), base, BVI_SIZES))
        with open(f"{VIZ}/bvi_trades.csv", "w") as f:
            w = csv.DictWriter(f, fieldnames=list(T[0].keys())); w.writeheader(); w.writerows(T)
        print(f"Bot vs Indi trades: {len(T)} trades -> {VIZ}/bvi_trades.csv", flush=True)


def account(rows, pct, key="ret"):
    """Each trade `pct` of the account at the start of its day, from $100,000 -> (end, worst drop)."""
    eq, peak, dd, cur, start = 1e5, 1e5, 0.0, None, 1e5
    for r in sorted(rows, key=lambda r: (r["date"], float(r.get("minute") or 0))):
        if r["date"] != cur: cur = r["date"]; start = eq; peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        eq += pct * start * max(-1.0, float(r[key]))
    return eq, max(dd, 1 - eq / max(peak, eq))


def table(title, groups, sizes=((0.01, "ret"), (0.02, "ret_2pct")), years=True):
    print(f"\n### {title}\n")
    print("| Version | Trades | Capped nights / nights | At 1% / worst drop: no cap -> cap | At 2% / worst drop: no cap -> cap |" + (" 2024 / 2025 / 2026 at $10K (1%) |" if years else ""))
    print("|---|---|---|---|---|" + ("---|" if years else ""))
    for name, rows in groups:
        nights = sum(int(r.get("overnight") or 0) for r in rows)
        capped = sum(1 for r in rows if abs(float(r["ret_2pct"]) - float(r["ret_nocap"])) > 1e-6)
        capped1 = sum(1 for r in rows if abs(float(r["ret"]) - float(r["ret_nocap"])) > 1e-6)
        cells = []
        for pct, key in sizes:
            e0, d0 = account(rows, pct, "ret_nocap"); e1, d1 = account(rows, pct, key)
            cells.append(f"${e0:,.0f} / {d0:.0%} -> ${e1:,.0f} / {d1:.0%}")
        yr = " / ".join(f"{sum(max(-1, float(r['ret'])) for r in rows if r['date'][:4] == y) * 10:+,.0f}K" for y in ("2024", "2025", "2026")) if years else ""
        print(f"| {name} | {len(rows)} | {capped1} at 1%, {capped} at 2% / {nights} | " + " | ".join(cells) + " |" + (f" {yr} |" if years else ""))


def walk_one(t):
    from fallback_drop import CHAMP, cu
    sim.X.clear(); sim.X.update(CHAMP)
    cost, steps, _ = sim.walk(t["sym"], t["date"], int(t["minute"]), t["right"], t["contract"], t["expiry"], cu.CAL)
    if cost is None: return None
    last = [s for s in steps if s[2] == "sell"][-1]
    return dict(list=t["list"], date=t["date"], minute=int(t["minute"]), sym=t["sym"], cost=round(cost, 4), overnight=int(last[0] != t["date"]),
                steps=";".join(f"{s[0]},{s[1]},{s[2]},{s[3]},{s[4]},{s[5]}" for s in steps))


def walk():
    from fallback_drop import signals
    T = [t for t in signals() if t["status"] == "ok" and t["list"] in ("fair", "unseen")]
    with mp.Pool(6) as pool: R = [r for r in pool.map(walk_one, T, chunksize=8) if r]
    json.dump(R, open(WALK, "w")); print(len(R), "trades ->", WALK)


def report():
    R = json.load(open(WALK))
    for r in R: r.update(rets(r["cost"], parse_path_steps(r["steps"]), sim.result(r["cost"], parse_path_steps(r["steps"]), 0)))
    table("Bot 2.5 (the D2 champion), re-walked", [(l, [r for r in R if r["list"] == l]) for l in ("fair", "unseen")])
    if os.path.exists(f"{VIZ}/bvi_trades.csv"):
        T = list(csv.DictReader(open(f"{VIZ}/bvi_trades.csv")))
        names = {t["version"]: t["version_name"] for t in T}
        table("Bot vs Indi versions (fair list)", [(f"{v} ({names[v][:40]})", [t for t in T if t["version"] == v]) for v in ("d2-bonus", "bot24", "d2-bot", "t18-rest20", "t18-hold50", "t18-news")])
    T = list(csv.DictReader(open(f"{VIZ}/trades.csv")))
    lists_ = [l for l in dict.fromkeys(t["list"] for t in T)]
    table("Backtest Reports lists", [(l, [t for t in T if t["list"] == l]) for l in lists_], years=False)


if __name__ == "__main__":
    {"lists": lists, "viz": viz, "walk": walk, "report": report}[sys.argv[1]]()
