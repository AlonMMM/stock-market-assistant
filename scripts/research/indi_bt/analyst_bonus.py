"""A bonus for an analyst action (the user, 2026-10-27: "what do you think about testing a bonus for stock that had
upgrade/downgrade from an know analyst organisation?"; "yes start it"). On the champion (2.5 + IBIT down to $0.10 + the
pyramid), real quotes. An action counts for a trade when a big house (analyst_news.py `known`) published it between the
previous session's close and the signal minute, on the same stock: an upgrade (or a raised target) confirms a call, a
downgrade (or a cut target) a put; the other way it is against. Set before running:
  base        the champion
  size-ud     1.5x the size on a trade confirmed by an upgrade / downgrade
  size-all    1.5x the size on a trade confirmed by an upgrade / downgrade or a target change
  skip-ud     no trade against an upgrade / downgrade
  pre-ud      also trade a signal the pre-market volume skip (4x) dropped, when an upgrade / downgrade confirms it
  combo       size-ud + skip-ud + pre-ud
Then (the user, 2026-10-27: "try only for those trades turn off these filters": the pre-market skip and the earnings
reaction day), on an upgrade / downgrade day only, both filters off:
  lift-conf   when the action is in the trade's direction
  lift-any    in either direction
  (ANALYST_RUN=lift prints these two against the base, with every trade they add)
Tune / check by entry week (split.py), the fair list and the Favorites 24 months.

  node --env-file=.env <dir>/run.mjs analyst_bonus.py      (from the app repo root)
-> data/local/x/bt/analyst_bonus_summary.json
"""
import bisect, collections, csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import fair_fill as FF
import fav_real as FR
import news_filter as nf
import real_bench as RB
from low_delta import HIS40, PRIOR
from score_sum import account, held as booked
from split import half
from store import calendar

B = "data/local/x/bt"
CAL = calendar()
VARIANTS = ("base", "size-ud", "size-all", "skip-ud", "pre-ud", "combo")
if os.environ.get("ANALYST_RUN") == "lift": VARIANTS = ("base", "lift-conf", "lift-any")


def actions():
    """{sym: sorted [(date, minute, kind, direction)]} of the big houses with a direction."""
    by = collections.defaultdict(list)
    for r in csv.DictReader(open(f"{B}/analyst_actions.csv")):
        if r["known"] == "1" and r["direction"] != "0": by[r["sym"]].append((r["date"], int(r["minute"]), r["kind"], int(r["direction"])))
    for v in by.values(): v.sort()
    return by


def tag(t, A):
    """-> (confirming kinds, against kinds) for a signal: actions from the previous close to the signal minute."""
    i = CAL.index(t["date"])
    prev = CAL[i - 1]
    side = 1 if t["right"] == "C" else -1
    conf, against = set(), set()
    for d, m, kind, direction in A.get(t["sym"], ()):
        if (d, m) <= (prev, 390) or (d, m) > (t["date"], int(t["minute"])): continue
        (conf if direction == side else against).add(kind)
    return conf, against


def fair_rows(prefix, pre):
    """The fair list's signals; pre = only the ones the pre-market skip dropped."""
    T = [t for f in glob.glob(f"{B}/{prefix}_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] in ("ok", "too_cheap", "illiquid")]
    nf.features(T)
    passes = lambda t: t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)
    lifted = lambda t: t["e_next"] == 0 or (t["pre_rvol"] is not None and t["pre_rvol"] >= 4)
    keep = lifted if pre else passes
    if pre and os.environ.get("ANALYST_RUN") != "lift": keep = lambda t: t["e_next"] != 0 and t["pre_rvol"] is not None and t["pre_rvol"] >= 4
    return [t for t in T if keep(t) and t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]] and t["date"] <= RB.LAST]


def fav_pre(entry):
    """The Favorites' signals the pre-market skip dropped (lists.py status 'skipped: pre-market volume Nx')."""
    out = []
    for name, a, z in FR.LISTS[entry]:
        for r in json.load(open(f"{B}/list_{name}_{a}_{z}.json")):
            st = str(r["status"])
            lifted = st.startswith("skipped: pre-market volume") or (os.environ.get("ANALYST_RUN") == "lift" and st == "skipped: earnings reaction day")
            if lifted and r["date"] >= FR.A24: out.append(dict(r, minute=str(r["minute"])))
    return out


def one(job):
    src, kind, pre, t = job
    r = FF.one((src, kind, t))
    if not r: return None
    r["pre"] = pre
    for k in ("path",): r.pop(k, None)
    return r, t


ADDED = []


def leg_ret(r, units):
    return sim.result(r["paid"], r["steps"], 0.01 * units)


def book(r, k):
    """score_sum.held of a leg, its marks at k times the size (as its pnl)."""
    h = booked(r["paid"], r["steps"])
    return dict(h, marks={d: k * x for d, x in h["marks"].items()})


def entries(R, src, part, v, A):
    sized = v in ("size-ud", "size-all", "combo")
    skip = v in ("skip-ud", "combo")
    with_pre = v in ("pre-ud", "combo", "lift-conf")
    any_dir = v == "lift-any"
    main = [(r, t) for r, t in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == part]
    adds = collections.defaultdict(list)
    for r, t in R:
        if r["src"] == src and r["kind"] == "add": adds[(r["date"], r["sym"], r["right"])].append(r)
    E, touched = [], 0
    for r, t in main:
        conf, against = tag(t, A)
        ud = bool(conf & {"upgrade", "downgrade"})
        ud_any = ud or bool(against & {"upgrade", "downgrade"})
        if r["pre"] and not ((with_pre and ud) or (any_dir and ud_any)): continue
        if skip and against & {"upgrade", "downgrade"}: touched += 1; continue
        mult = 1.0
        if sized and (ud or (v == "size-all" and conf)): mult = 1.5; touched += 1
        if r["pre"]: touched += 1; ADDED.append((v, r["src"], r["date"], r["sym"], r["right"], "confirms" if ud else "against", round(1e4 * max(-1, leg_ret(r, 1.0)))))
        E.append((r["date"], r["minute"], mult, leg_ret(r, mult), r["sym"], book(r, mult)))
        if not r["d2"]: continue
        for a in sorted(adds.get((r["date"], r["sym"], r["right"]), []), key=lambda x: x["minute"]):
            if a["minute"] <= r["minute"] or a["pre"]: continue
            share, up = r["held"].get(a["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((a["date"], a["minute"], 0.5 * mult, leg_ret(a, 0.5 * mult), a["sym"], book(a, 0.5 * mult)))
            break
    return E, touched


def stats(E):
    R = sorted(E, key=lambda e: e[:5])
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[3])), **e[5]) for e in R]
    acct, dd = account(pnl)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top])
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R))


def main():
    A = actions()
    jobs = [("fair", "main", False, t) for t in fair_rows("sg_c12_15", False)] + [("fair", "add", False, t) for t in fair_rows("s_t18r15", False)]
    jobs += [("fair", "main", True, t) for t in fair_rows("sg_c12_15", True)]
    jobs += [("fav", "main", False, t) for t in FR.signals("25")] + [("fav", "add", False, t) for t in FR.signals("24")]
    jobs += [("fav", "main", True, t) for t in fav_pre("25")]
    print(len(jobs), "signals", flush=True)
    with mp.Pool(8) as pool: R = [x for x in pool.map(one, jobs, chunksize=4) if x]
    n_conf = sum(bool(tag(t, A)[0] & {"upgrade", "downgrade"}) for r, t in R if r["kind"] == "main" and not r["pre"])
    n_ag = sum(bool(tag(t, A)[1] & {"upgrade", "downgrade"}) for r, t in R if r["kind"] == "main" and not r["pre"])
    n_pre = sum(bool(tag(t, A)[0] & {"upgrade", "downgrade"}) for r, t in R if r["pre"])
    print(f"champion trades confirmed by an upgrade / downgrade: {n_conf}; against: {n_ag}; pre-market-skipped and confirmed: {n_pre}", flush=True)
    out = {}
    print("\n### Tune weeks, real quotes, 1% from $100,000\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) | Trades changed (fair / fav) |\n|---|---|---|---|---|")
    for v in VARIANTS:
        (ef, tf), (ev, tv) = entries(R, "fair", "tune", v, A), entries(R, "fav", "tune", v, A)
        f, g = stats(ef), stats([e for e in ev if e[0] >= FR.A24])
        out[f"tune|{v}"] = dict(fair=f, fav=g, touched=(tf, tv))
        print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} | {tf} / {tv} |", flush=True)
    base = out["tune|base"]
    score = lambda v: min(out[f"tune|{v}"]["fair"]["acct"] / base["fair"]["acct"], out[f"tune|{v}"]["fav"]["acct"] / base["fav"]["acct"])
    best = max(VARIANTS[1:], key=score)
    print(f"\nPicked on tune: {best}; better than the champion on both tune lists: {score(best) > 1}\n")
    print("### Check weeks, one run\n\n| Variant | Fair list | Favorites 24m | Without the best 5 (fair / fav) |\n|---|---|---|---|")
    for v in ("base", best):
        f, g = stats(entries(R, "fair", "check", v, A)[0]), stats([e for e in entries(R, "fav", "check", v, A)[0] if e[0] >= FR.A24])
        out[f"check|{v}"] = dict(fair=f, fav=g)
        print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} |", flush=True)
    out["best"] = best
    seen = set()
    print("\n### The trades the lifted filters add (all weeks), P&L at $10K\n")
    for v in VARIANTS[1:]:
        for x in sorted({a for a in ADDED if a[0] == v}):
            if x not in seen: seen.add(x); print("|", " | ".join(map(str, x)), "|")
    json.dump(out, open(f"{B}/analyst_bonus_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
