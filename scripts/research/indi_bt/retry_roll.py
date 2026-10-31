"""Two tests on the champion (the user, 2026-10-27):
  1. "try again the same ticker - but only if the first attemp was in the first 30minutes of open": after a champion
     trade that entered before 10:00 (minute < 30) and was fully sold the same day, a second trade on the same stock at
     the first minute after that sale where the champion's entry rule holds again (t >= 1.8, or t >= 1.2 and D2 >= 1.5;
     volume >= 1.5x; defence_signals.py BT_ALL=1). One retry a stock a day, full size, the champion's pick and exits, no
     pyramid on it. Set before running:
       retry        the same side only
       retry-any    either side
       retry-loss   the same side, only after a first trade that lost
  2. "rolling ... when big winner come a close/into the mony - we start to check if and when the stock is still locking
     good. when the stock in a place that the bot would enter (t > 1.8 bla bla) we are rolling and buy with half of the
     gain the next 0.15 delta. we sell all the old position and keep going with the half": once the stock has come to the
     strike (any day held), at the first minute after that the entry rule holds on the same side, sell all of the old
     position at the bid and put half of the gain into a fresh 0.20-delta pick (the user: "0.25 not 0.15", then "all delta is 0.2") (the champion's pick, IBIT down to $0.10),
     walked with the champion's exits from that minute; the other half of the gain and the cost are kept. The trade's
     return = old + old / 2 x new. One roll a trade. Set before running:
       roll         at the money, the champion's rule
       roll-t18     at the money, t >= 1.8 and volume only ("t > 1.8")
       roll-near25  75% of the way from the entry price to the strike, the champion's rule
The pyramid's add stays as the champion's (decided on the first leg's real mid). Real quotes where cached; a new contract
(a retry or a roll leg) has no cached book unless the champion bought it, so its fills keep the walk's +-2% price: the
share of those fills on the book is reported. Picked on the tune weeks (split.py): the best retry and the best roll by
min(fair, Favorites) against the champion, then every version on the check weeks too (the user: "prints both"), the pick marked; the verdict reads the pick only.

  node --env-file=.env <dir>/run.mjs retry_roll.py      (from the app repo root; after defence_signals.py BT_ALL=1)
-> data/local/x/bt/retry_roll_summary_<size>.json
"""
import collections, csv, glob, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
import cheap_up as cu
import fav_real as FR
import fill_models as fm
import floor_exception as fe
import opt_spread as OS
import real_bench as RB
from d2_failed_break import CHAMP
from score_sum import account, held as booked
from signals import series
from split import half
from store import calendar, day, iv_delta, years_to_expiry

B = "data/local/x/bt"
CAL = calendar()
SIZES = (0.02, 0.03)
RETRY = ("retry", "retry-any", "retry-loss")
# name -> (the rule that must hold at the roll minute, the trigger, its level)
ROLL = {"roll": ("c12_15", "near", 0.0), "roll-t18": ("base", "near", 0.0), "roll-near25": ("c12_15", "near", 0.25),
        # the user, 2026-10-27: "you can roll if you enter the mony say delta 0.65 and test it": the option's delta (from its
        # 1-minute close, store.iv_delta) at 0.65 / 0.80
        "roll-d65": ("c12_15", "delta", 0.65), "roll-d80": ("c12_15", "delta", 0.80),
        # "Also test rolling on lower delta before the night": on a day the champion holds overnight, at the first minute from
        # 15:30 (15:00) to 15:44 the rule holds, roll into the ROLL_DELTA pick and hold it that night
        "roll-night": ("c12_15", "night", 360), "roll-night60": ("c12_15", "night", 330)}
ONLY = os.environ.get("RR_ONLY", "")   # "roll": skip the retries
# how much goes into the new leg, as a share of the first stake (ro = the old leg's return). The user, 2026-10-27:
# "what if we roll all the position and not half?": "-gain" all of the gain, "-all" everything the sale brought in
FUNDS = {"": lambda ro: max(ro, 0) / 2, "-gain": lambda ro: max(ro, 0), "-all": lambda ro: max(1 + ro, 0)}
ROLLV = [v + f for v in ROLL for f in FUNDS]


def load_all():
    out = {}
    for rule in ("c12_15", "base"):
        for f in glob.glob(f"{B}/s_all_{rule}_20*.csv"):
            for r in csv.DictReader(open(f)):
                out[(rule, r["sym"], r["date"], r["right"])] = (list(map(int, r["minutes"].split())), list(map(float, r["ts"].split())))
    return out


ALL = load_all()


def next_minute(rule, sym, date, right, after):
    """The first minute > after where the rule holds on that side, and its t."""
    v = ALL.get((rule, sym, date, right))
    if not v: return None
    for m, t in zip(*v):
        if m > after: return m, t
    return None


def pick(sym, date, m, right, price, target=0.15):
    """The champion's pick (IBIT down to $0.10, 200 contracts in 30 minutes), at the delta closest to `target`."""
    cands = cu.candidates(sym, date, m, right, price)
    if not cands: return None
    best = min(cands, key=lambda c: abs(c[3] - target))
    if best[4] < (0.10 if sym == "IBIT" else 0.20) or best[5] < 200: return None
    return best[0], best[1]


# the roll's new leg (the user, 2026-10-27: "we want to put in higher delta - 0.25 not 0.15 (rolling)";
# later that day: "all delta is 0.2", the roll leg only, the champion's entries stay at 0.15). RR_DELTA=0.25 reruns the old one.
ROLL_DELTA = float(os.environ.get("RR_DELTA", "0.20"))


def leg(sym, date, m, right, c, exits=CHAMP):
    """The champion's walk from (date, m) on contract c at real prices: (real cost, real steps, book share of fills)."""
    sim.X.clear(); sim.X.update(exits)
    cost, steps, _ = sim.walk(sym, date, m, right, c[0], c[1], CAL)
    if cost is None: return None
    rcost, real = OS.price(steps, c[0], cost, "bid")
    fills = [s for s in steps if s[2] in ("buy", "sell")]
    book = sum(bool(RB.quote(c[0], s[0], max(s[1] - 1, 0))) for s in fills) / max(1, len(fills))
    return rcost, real, book


def closes(sym, d):
    return series(day(sym, d))[0]


def one(job):
    src, kind, t = job
    if RB.DBX != fm.DBX[src]: RB.DBX = fm.DBX[src]; RB.Q.clear(); RB.OI.clear()
    sym, date, right, m0 = t["sym"], t["date"], t["right"], int(t["minute"])
    c = pick(sym, date, m0, right, float(t["price"]))
    if not c: return None
    base = leg(sym, date, m0, right, c)
    if not base: return None
    rcost, real, book = base
    out = dict(src=src, kind=kind, date=date, minute=m0, sym=sym, right=right, d2=int(float(t.get("c_t") or 9) < 1.8),
               base={s: sim.result(rcost, real, s) for s in SIZES} | {"h": {s: sim.result(rcost, real, s / 2) for s in SIZES}},
               over=int(any(s[0] != date for s in real if s[2] == "sell")), book=book, retry={}, roll={},
               hd=booked(rcost, real))
    sells = [s for s in real if s[2] == "sell"]
    if kind == "add": return out
    held = {}
    for mm in range(m0, 390):
        k = RB.quote(c[0], date, mm)
        held[mm] = (1 - sum(s[3] for s in sells if s[0] == date and s[1] <= mm), None if not k else (k[0] + k[1]) / 2 / rcost - 1)
    out["held"] = held
    # 1. the retry: an early first trade, fully sold on the entry day
    if m0 < 30 and not out["over"] and ONLY != "roll":
        xm = max(s[1] for s in sells)
        lost = out["base"][0.02] < 0
        sides = {"retry": [right], "retry-any": ["C", "P"], "retry-loss": [right] if lost else []}
        cl = closes(sym, date)
        done = {}
        for v, rs in sides.items():
            hits = [(h[0], r, h[1]) for r in rs for h in [next_minute("c12_15", sym, date, r, xm)] if h]
            if not hits: continue
            m1, r1, t1 = min(hits)
            if m1 > 374 or not cl[m1]: continue
            if (m1, r1) not in done:
                c1 = pick(sym, date, m1, r1, cl[m1])
                g1 = leg(sym, date, m1, r1, c1) if c1 else None
                done[(m1, r1)] = None if not g1 else dict(minute=m1, right=r1, t=t1, contract=c1[0], book=g1[2],
                                                          r={s: sim.result(g1[0], g1[1], s) for s in SIZES},
                                                          hd=booked(g1[0], g1[1]))
            if done[(m1, r1)]: out["retry"][v] = done[(m1, r1)]
    # 2. the roll: the stock at (or near) the strike while the position is held, then the entry rule on the same side
    bet = 1 if right == "C" else -1
    k = float(c[0][-8:]) / 1000
    s0 = closes(sym, date)[m0]
    last = (sells[-1][0], sells[-1][1])
    days = [d for d in CAL if date <= d <= last[0]]
    carry_days = {s[0] for s in real if s[2] == "carry"}
    obars = {d: {b[0]: b for b in day(c[0], d)} for d in days}
    for v, (rule, mode, level) in ROLL.items():
        if not s0 or bet * (k - s0) <= 0: break
        trig = None
        roll_at = None
        for d in days:
            cl = closes(sym, d)
            start = m0 + 1 if d == date else 0
            hold = set(ALL.get((rule, sym, d, right), ([], []))[0])
            for mm in range(start, 390):
                if (d, mm) >= last: break
                if mode == "night":
                    if d in carry_days and level <= mm <= 374 and mm in hold: roll_at = (d, mm); break
                    continue
                if trig is None and cl[mm] and mode == "near" and bet * (k - cl[mm]) / (bet * (k - s0)) <= level: trig = (d, mm)
                if trig is None and cl[mm] and mode == "delta" and mm in obars[d]:
                    x = iv_delta(obars[d][mm][4], cl[mm], k, years_to_expiry(d, mm, c[1]), sim.C["rate"], right == "C")
                    if x and x[1] >= level: trig = (d, mm)
                if trig is None or not (10 <= mm <= 374): continue
                if mm in hold: roll_at = (d, mm); break
            if roll_at or (d, 389) >= last: break
        if not roll_at: continue
        d, mm = roll_at
        rem = 1 - sum(s[3] for s in sells if (s[0], s[1]) <= (d, mm))
        q = RB.quote(c[0], d, mm)
        bars = {b[0]: b for b in day(c[0], d)}
        bid = q[0] if q else None
        if bid is None and mm in bars: bid = bars[mm][4] * (1 - sim.SH)
        if not bid or rem <= 0: continue
        old = [s for s in real if s[2] != "sell" or (s[0], s[1]) <= (d, mm)] + [(d, mm, "sell", round(rem, 4), round(bid, 4), "R_roll")]
        cl = closes(sym, d)
        c2 = pick(sym, d, mm, right, cl[mm], ROLL_DELTA) if cl[mm] else None
        exits = {**CHAMP, "carry_force_first": True} if mode == "night" else CHAMP
        g2 = leg(sym, d, mm, right, c2, exits) if c2 else None
        if not g2: continue
        # booked on the new leg's sale day: the old leg's marks before the roll, then its gross result + the new leg's
        mo, mn = booked(rcost, old), booked(g2[0], g2[1])
        g_old = sum(x[3] * x[4] for x in old if x[2] == "sell") / rcost - 1
        for f, fund in FUNDS.items():
            r, hd = {}, {}
            for s in SIZES:
                ro = sim.result(rcost, old, s)
                # fund(ro) of the first stake into the new leg: a position of s x fund(ro) of the account (the overnight cap at that size)
                rn = sim.result(g2[0], g2[1], s * fund(ro))
                r[s] = ro + fund(ro) * max(-1, rn)
                hd[s] = dict(exit_day=mn["exit_day"], marks={**{x: y for x, y in mo["marks"].items() if x < d},
                                                             **{x: g_old + fund(ro) * y for x, y in mn["marks"].items()}})
            out["roll"][v + f] = dict(day=d, minute=mm, contract=c2[0], book=g2[2], old=round(sim.result(rcost, old, 0.02), 3),
                                      new=round(sim.result(g2[0], g2[1], 0.02), 3), r=r, hd=hd)
    return out


def entries(R, adds, src, v, part, size, a=""):
    E = []
    for r in R:
        if r["src"] != src or r["kind"] != "main" or half(r["date"]) != part or r["date"] < a: continue
        ret, hd = r["base"][size], r["hd"]
        if v in ROLLV and v in r["roll"]: ret, hd = r["roll"][v]["r"][size], r["roll"][v]["hd"][size]
        E.append((r["date"], r["minute"], 1.0, ret, r["over"], hd))
        if v in RETRY and v in r["retry"]:
            x = r["retry"][v]; E.append((r["date"], x["minute"], 1.0, x["r"][size], 0, x["hd"]))
        if not r["d2"]: continue
        for ad in sorted(adds.get((src, r["date"], r["sym"], r["right"]), []), key=lambda q: q["minute"]):
            if ad["minute"] <= r["minute"]: continue
            share, up = r["held"].get(ad["minute"], (0, None))
            if share > 0 and up is not None and up > 0: E.append((ad["date"], ad["minute"], 0.5, ad["base"]["h"][size], ad["over"], ad["hd"]))
            break
    return E


def stats(E, size):
    R = sorted(E, key=lambda e: e[:5])
    pnl = [dict(date=e[0], pnl=str(1e4 * e[2] * max(-1, e[3]))) for e in R]
    for p, e in zip(pnl, R):  # a 6th element: the leg's held() (other scripts pass 5)
        h = e[5] if len(e) > 5 and isinstance(e[5], dict) and "exit_day" in e[5] else None
        if h: p.update(exit_day=h["exit_day"], marks={d: e[2] * v for d, v in h["marks"].items()})
    acct, dd = account(pnl, size)
    top = set(sorted(range(len(R)), key=lambda i: -R[i][2] * R[i][3])[:5])
    a5, _ = account([p for i, p in enumerate(pnl) if i not in top], size)
    return dict(acct=round(acct), dd=round(dd, 3), no5=round(a5), trades=len(R), win=round(sum(e[3] > 0 for e in R) / max(1, len(R)), 3))


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals,", len(ALL), "rule-minute rows", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    V = ["base", *ROLLV] if ONLY == "roll" else ["base", *RETRY, *ROLLV]
    out = {}
    for size in SIZES:
        print(f"\n### Tune weeks, real quotes, {size:.0%} from $100,000\n\n| Version | Fair list | Favorites 24m | Without the best 5 (fair / fav) | "
              f"Trades (fair / fav) | Extra trades or rolls (fair / fav) | Their sum at $10K (fair / fav) | New legs' fills on the book |\n|---|---|---|---|---|---|---|---|")
        for v in V:
            f = stats(entries(R, adds, "fair", v, "tune", size), size)
            g = stats(entries(R, adds, "fav", v, "tune", size, FR.A24), size)
            n, tot, bk = {}, {}, []
            for src, a in (("fair", ""), ("fav", FR.A24)):
                rows = [r for r in R if r["src"] == src and r["kind"] == "main" and half(r["date"]) == "tune" and r["date"] >= a]
                if v in RETRY:
                    hit = [r["retry"][v] for r in rows if v in r["retry"]]
                    n[src], tot[src] = len(hit), round(sum(1e4 * max(-1, x["r"][size]) for x in hit))
                    bk += [x["book"] for x in hit]
                elif v in ROLLV:
                    hit = [r for r in rows if v in r["roll"]]
                    n[src], tot[src] = len(hit), round(sum(1e4 * (r["roll"][v]["r"][size] - r["base"][size]) for r in hit))
                    bk += [r["roll"][v]["book"] for r in hit]
                else: n[src], tot[src] = 0, 0
            out[f"{size}|{v}"] = dict(fair=f, fav=g, n=n, tot=tot)
            book = f"{sum(bk) / len(bk):.0%}" if bk else "—"
            print(f"| {v} | ${f['acct']:,} / {f['dd']:.0%} | ${g['acct']:,} / {g['dd']:.0%} | ${f['no5']:,} / ${g['no5']:,} | {f['trades']} / {g['trades']} | "
                  f"{n['fair']} / {n['fav']} | {tot['fair']:+,} / {tot['fav']:+,} | {book} |", flush=True)
    # the pick of each idea on tune, then one run on the check weeks
    for name, group in (("retry", RETRY), ("roll", tuple(ROLLV))):
        if name == "retry" and ONLY == "roll": continue
        score = lambda v: min(out[f"0.02|{v}"]["fair"]["acct"] / out["0.02|base"]["fair"]["acct"], out[f"0.02|{v}"]["fav"]["acct"] / out["0.02|base"]["fav"]["acct"])
        best = max(group, key=score)
        out[f"best|{name}"] = best
        print(f"\nPicked on tune ({name}): {best}; better than the champion on both tune lists at 2%: {score(best) > 1}")
        print(f"\n### Check weeks ({name}; 🎯 = picked on tune)\n\n| Version | 2%: fair list | 2%: Favorites 24m | 3%: fair list | 3%: Favorites 24m | Without the best 5 at 2% (fair / fav) |\n|---|---|---|---|---|---|")
        for v in ("base", *group):
            c2 = [stats(entries(R, adds, src, v, "check", 0.02, a), 0.02) for src, a in (("fair", ""), ("fav", FR.A24))]
            c3 = [stats(entries(R, adds, src, v, "check", 0.03, a), 0.03) for src, a in (("fair", ""), ("fav", FR.A24))]
            out[f"check|{name}|{v}"] = dict(fair2=c2[0], fav2=c2[1], fair3=c3[0], fav3=c3[1])
            mark = " 🎯" if v == best else ""
            print(f"| {v}{mark} | ${c2[0]['acct']:,} / {c2[0]['dd']:.0%} | ${c2[1]['acct']:,} / {c2[1]['dd']:.0%} | ${c3[0]['acct']:,} / {c3[0]['dd']:.0%} | "
                  f"${c3[1]['acct']:,} / {c3[1]['dd']:.0%} | ${c2[0]['no5']:,} / ${c2[1]['no5']:,} |", flush=True)
    # every roll and retry on the tune weeks, for the report
    print("\n### The rolls (2%): half, entry, roll, old leg, new leg, the trade before -> after")
    for r in sorted(R, key=lambda q: (half(q["date"]), q["date"])):
        if r["kind"] != "main" or (r["src"] == "fav" and r["date"] < FR.A24): continue
        for v, x in r["roll"].items():
            if v not in ("roll", "roll-d65", "roll-night"): continue
            print(f"  {v} {half(r['date'])} {r['src']} {r['date']} {r['sym']} {r['right']} -> {x['day']} m{x['minute']} {x['contract']}: old {x['old']:+.0%}, new {x['new']:+.0%}, "
              f"{r['base'][0.02]:+.0%} -> {x['r'][0.02]:+.0%}", flush=True)
    json.dump(out, open(f"{B}/retry_roll_summary{'_' + ONLY if ONLY else ''}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
