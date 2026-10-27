"""Size by the account's drawdown (the user, 2026-10-27: "if we're down 12.5 from the top use 0.5 size. until we claim
half the way back - than move to regular size. on the top you can double the size until we loosing 5%"), on the
champion (2.5 + IBIT down to $0.10 + the pyramid), real quotes. A state, set at each day's start from the account then:
  double   at a new high: twice the base size, until the account is 5% under its high -> normal
  normal   the base size; 12.5% under the high -> half
  half     half the base size, until half the drop is won back (account >= low + (high - low) / 2) -> normal
Set before running: base 1%, 2%, 3% (live runs 3%), the rule off and on; neighbours: the half-size trigger at 10% and
15%. Every trade's return is recomputed at its real size (sim.result, the 10% overnight cap at that size); a pyramid
add is half a trade at half the size. Lists: the fair list (2024-25, 2026 held out) and the Favorites (12 / 6 months).

  python3 <dir>/dd_sizing_rule.py <export dir with champ_trades.csv and champ_fills_real.csv>      (from the app repo root)
"""
import csv, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim

csv.field_size_limit(10 ** 9)
RULES = {"off": None, "rule 12.5%": 0.125, "rule 10%": 0.10, "rule 15%": 0.15}
BASES = (0.01, 0.02, 0.03)


def parse(steps):
    out = []
    for x in steps.split(";"):
        d, m, side, q, px, rule = x.split(",")
        out.append((d, int(m), side, float(q), float(px), rule))
    return out


def ret_at(t, pct):
    """The trade's return per unit of `pct` of the account (an add: half a trade at half the size)."""
    k = 0.5 if t["half"] else 1.0
    key = round(pct * k, 5)
    if key not in t["memo"]: t["memo"][key] = k * sim.result(t["cost"], t["steps"], pct * k)
    return t["memo"][key]


def run(T, base, cut):
    T = sorted(T, key=lambda t: (t["date"], t["minute"]))
    acct, high, low, state, cur, size = 1e5, 1e5, 1e5, "double", None, base
    worst, days = 0, {"double": 0, "normal": 0, "half": 0}
    for t in T:
        if t["date"] != cur:
            cur = t["date"]
            if acct >= high: high, low, state = acct, acct, "double"
            low = min(low, acct)
            dd = 1 - acct / high
            worst = max(worst, dd)
            if cut is None: state = "normal"
            elif state == "double" and dd >= 0.05: state = "normal"
            if cut is not None and state == "normal" and dd >= cut: state = "half"
            if cut is not None and state == "half" and acct >= low + (high - low) / 2: state = "normal"
            mult = 1.0
            if state == "double": mult = 2.0
            elif state == "half": mult = 0.5
            size = base * mult
            start = acct
            days[state] += 1
        acct += size * start * max(-1, ret_at(t, size))
    worst = max(worst, 1 - acct / max(high, acct))
    return round(acct), round(worst, 3), days


def main():
    d = sys.argv[1]
    T = {r["key"]: r for r in csv.DictReader(open(f"{d}/champ_trades.csv")) if r["version"].endswith("champ")}
    F = {r["key"]: r for r in csv.DictReader(open(f"{d}/champ_fills_real.csv"))}
    lists = {}
    for k, r in T.items():
        lst = r["version"].split(":")[0] if ":" in r["version"] else "fair"
        f = F[k]
        lists.setdefault(lst, []).append(dict(date=r["date"], minute=int(r["minute"]), half=k.endswith("+add"), cost=float(f["cost"]), steps=parse(f["steps"]), memo={}))
    cuts = [("fair", "2024-25", "2024-01-01", "2025-12-31"), ("fair", "2026", "2026-01-01", "2026-12-31"),
            ("fav12", "Favorites 12m", "", "9"), ("fav6", "Favorites 6m", "", "9")]
    print("| Base | Rule | " + " | ".join(c[1] for c in cuts) + " | Days double / normal / half (fair 2024-25) |")
    print("|---|---|" + "---|" * (len(cuts) + 1))
    for base in BASES:
        for name, cut in RULES.items():
            cells, days0 = [], None
            for lst, label, a, z in cuts:
                acct, worst, days = run([t for t in lists[lst] if a <= t["date"] <= z], base, cut)
                cells.append(f"${acct:,} / {worst:.0%}")
                if days0 is None: days0 = days
            print(f"| {base:.0%} | {name} | " + " | ".join(cells) + f" | {days0['double']} / {days0['normal']} / {days0['half']} |", flush=True)


if __name__ == "__main__":
    main()
