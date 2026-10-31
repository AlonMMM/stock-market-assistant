"""The headline account from an export's trades (the audit of 2026-10-31, B9: "the headline cannot be reproduced from
Git"). One replay for every headline figure, the live bot's way: each trade is `size` of the account as its entry day
starts (closed trades plus the open ones marked at their last 15:50 carry price), its P&L joins on the day of its last
sale; a pyramid add's returns are already half a trade at half the size (export_champ.rets), never halved again.

  python3 replay.py <export dir> [version ...]      (export_early.py's early_trades.csv / early_paths.csv, or
                                                      export_fav_long.py's favlong_*; default version champ-early)
  REPLAY_MODE=entry   the old booking (the whole result on the entry day), to compare with figures logged before
-> per version: trades, won, account at 1% / 2% / 3% (ret, ret_2pct, ret_3pct when present) and the worst drop, the
   tune (even ISO entry weeks) and check (odd) halves at 2%, and 2% without the best 5 trades.

The 2.8 headline: node --env-file=.env <dir>/run.mjs export_early.py <out> with
  BT_X='{"user_stop": {"checks": [], "out": -0.6}, "stock_stages": {"half": 0.5, "full": 1.0}, "late_hold": {"from": 330}}'
then python3 replay.py <out> champ-early fav12:champ-early fav6:champ-early.
"""
import collections, csv, datetime as dt, glob, os, sys
csv.field_size_limit(1 << 30)
MODE = os.environ.get("REPLAY_MODE", "marked")


def load(d, version):
    t_file = (glob.glob(f"{d}/early_trades.csv") or glob.glob(f"{d}/favlong_trades.csv"))[0]
    p_file = t_file.replace("_trades.csv", "_paths.csv")
    P = {r["key"]: r for r in csv.DictReader(open(p_file))}
    T = [r for r in csv.DictReader(open(t_file)) if r["version"] == version]
    for t in T:
        p = P.get(t["key"]); steps = [x.split(",") for x in p["steps"].split(";")] if p else []
        sells = [s for s in steps if s[2] == "sell"]
        t["exit_day"] = max((s[0] for s in sells), default=t["date"])
        k = 0.5 if t["key"].endswith("+add") else 1.0
        cost = float(p["cost"]) if p else 0
        t["marks"] = {s[0]: k * ((sum(float(x[3]) * float(x[4]) for x in sells if x[0] <= s[0]) + float(s[3]) * float(s[4])) / cost - 1)
                      for s in steps if s[2] == "carry" and cost > 0}
    return T


def account(T, col="ret_2pct", size=0.02):
    """(end, worst drop) from $100,000."""
    by = collections.defaultdict(list)
    for t in T: by[t["date"]].append(t)
    days = sorted(set(by) | {t["exit_day"] for t in T})
    eq, peak, dd, held, prev = 1e5, 1e5, 0.0, [], None
    for d in days:
        if MODE == "entry":
            base = eq
            for t in by.get(d, []): eq += base * size * float(t[col])
            peak = max(peak, eq); dd = max(dd, 1 - eq / peak); continue
        base = eq + sum(stake * t["marks"].get(prev, 0.0) for stake, t in held)
        held += [(base * size, t) for t in by.get(d, [])]
        keep = []
        for stake, t in held:
            if t["exit_day"] == d: eq += stake * float(t[col])
            else: keep.append((stake, t))
        held = keep
        now = eq + sum(stake * t["marks"].get(d, 0.0) for stake, t in held)
        peak = max(peak, now); dd = max(dd, 1 - now / peak); prev = d
    return eq + sum(stake * float(t[col]) for stake, t in held), dd


def main():
    d = sys.argv[1]
    half = lambda t: dt.date.fromisoformat(t["date"]).isocalendar()[1] % 2
    print(f"{d} ({MODE} booking)")
    for v in sys.argv[2:] or ["champ-early"]:
        T = load(d, v)
        if not T: print(f"  {v}: no trades"); continue
        line = [f"  {v}: {len(T)} trades, {sum(float(t['ret']) > 0 for t in T) / len(T):.0%} won"]
        for col, size in (("ret", 0.01), ("ret_2pct", 0.02), ("ret_3pct", 0.03)):
            if col in T[0]: e, dd = account(T, col, size); line.append(f"{size:.0%} ${e:,.0f} ({dd:.1%})")
        best = {t["key"] for t in sorted(T, key=lambda t: -float(t["ret_2pct"]))[:5]}
        line.append(f"tune ${account([t for t in T if half(t) == 0])[0]:,.0f} / check ${account([t for t in T if half(t) == 1])[0]:,.0f}")
        line.append(f"without the best 5 ${account([t for t in T if t['key'] not in best])[0]:,.0f}")
        print(" | ".join(line))


if __name__ == "__main__":
    main()
