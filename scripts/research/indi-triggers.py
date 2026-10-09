"""Which chart events come right before his entries and his exits, and how much more often than chance.

Events (computed per 1-min bar from regular-session SIP bars, in the direction of his bet: call = up,
put = down; "fresh" = fired in the last 10 minutes, minutes-ago recorded):
  vol3 / vol5     one minute's volume >= 3x / 5x that minute's 20-session median
  new_high        close beyond the session's extreme so far (high for calls, low for puts), after 9:35
  or_break        first close beyond the 15-min opening range today
  prev_break      first close beyond yesterday's high / low today
  vwap_cross      close crosses VWAP to the bet side
  rs_jump         5-min move vs SPY x beta >= +0.5% in the bet direction
  tight_break     close beyond a 30-min range that was under half the stock's usual 30-min range
  pullback_turn   in a trend (>= +0.5% from the open), pulled back to the lower 60% of the day range,
                  then recovered 15 points of range within 5 minutes
  open15 / late   entry in the first 15 minutes / after 15:45 (states, not events)
Exit events (against the bet, last 10 minutes): stall10 / stall20 (no new extreme in 10 / 20 min),
vwap_lost, rs_drop (5-min vs SPY x beta <= -0.3%), spy_against (SPY 5-min <= -0.15% against the bet),
vol_dry (last-10-min volume < 0.8x normal), plus option drawdown from cost and from the peak since entry.

Baselines: entries vs 20 random minutes on the same stock, day and direction; exits vs every minute
he held the position without acting (between his open and his last sale, same day).

  python3 scripts/research/indi-triggers.py <data dir>  -> triggers_entries.csv, triggers_exits.csv
"""
import csv, json, sys, random, collections, statistics as st, datetime as dt, importlib.util, os

d = sys.argv[1]
spec = importlib.util.spec_from_file_location("feat", os.path.join(os.path.dirname(__file__), "indi-features.py"))
feat = importlib.util.module_from_spec(spec)
sys.argv = [sys.argv[0], d]
spec.loader.exec_module(feat)
feat.open_db(d)
PROXY = feat.PROXY

_rng = {}


def usual_range30(sym, date):
    """Median 30-minute high-low range (as a fraction of price) over the prior 5 sessions."""
    k = (sym, date)
    if k not in _rng:
        xs = []
        for p in feat.prior_dates(sym, date, 5):
            b = feat.day_bars(sym, p)
            for i in range(0, len(b) - 30, 10):
                w = b[i:i + 30]
                xs.append((max(x[2] for x in w) - min(x[3] for x in w)) / w[-1][4])
        _rng[k] = st.median(xs) if xs else None
    return _rng[k]


class Day:
    """Per-minute state for one stock-day in one bet direction."""

    def __init__(self, und, date, bet):
        self.sym = PROXY.get(und, und)
        self.bet = bet
        self.b = feat.day_bars(self.sym, date)
        self.spy = feat.day_bars("SPY", date)
        self.typ = feat.typical_volume(self.sym, date)
        self.beta = feat.beta(self.sym, date) if self.sym != "SPY" else 1.0
        prev = feat.prior_dates(self.sym, date, 1)
        pb = feat.day_bars(self.sym, prev[0]) if prev else []
        self.prev_hi = max((x[2] for x in pb), default=None)
        self.prev_lo = min((x[3] for x in pb), default=None)
        self.r30 = usual_range30(self.sym, date)
        n = len(self.b)
        self.ok = n > 300
        if not self.ok:
            return
        # Running values at the close of bar i (session minute i+1).
        self.vwap, self.ext, self.hi, self.lo, self.events = [], [], [], [], []
        pv = vv = 0.0
        hi, lo = -1e18, 1e18
        orh = max(x[2] for x in self.b[:15]) if n >= 15 else None
        orl = min(x[3] for x in self.b[:15]) if n >= 15 else None
        or_done = prev_done = False
        last_ext = 0
        for i, x in enumerate(self.b):
            m = x[6] + 1
            pv += (x[2] + x[3] + x[4]) / 3 * x[5]
            vv += x[5]
            vw = pv / vv if vv else x[4]
            ev = set()
            t = self.typ[x[6]]
            if t:
                if x[5] >= 3 * t: ev.add("vol3")
                if x[5] >= 5 * t: ev.add("vol5")
            c = x[4]
            if m > 5 and (c > hi if bet > 0 else c < lo): ev.add("new_high")
            if (c > hi if bet > 0 else c < lo):
                last_ext = m
            hi, lo = max(hi, x[2]), min(lo, x[3])
            if m > 15 and not or_done and orh is not None and (c > orh if bet > 0 else c < orl):
                ev.add("or_break"); or_done = True
            if self.prev_hi and not prev_done and (c > self.prev_hi if bet > 0 else c < self.prev_lo):
                ev.add("prev_break"); prev_done = True
            if i and ((self.b[i - 1][4] <= self.vwap[-1] and c > vw) if bet > 0 else (self.b[i - 1][4] >= self.vwap[-1] and c < vw)):
                ev.add("vwap_cross")
            if i and ((self.b[i - 1][4] >= self.vwap[-1] and c < vw) if bet > 0 else (self.b[i - 1][4] <= self.vwap[-1] and c > vw)):
                ev.add("vwap_lost")
            r5, s5 = feat.ret(self.b, m - 5, m), feat.ret(self.spy, m - 5, m)
            if None not in (r5, s5, self.beta):
                ex = bet * (r5 - self.beta * s5) * 100
                if ex >= 0.5: ev.add("rs_jump")
                if ex <= -0.3: ev.add("rs_drop")
            if s5 is not None and bet * s5 * 100 <= -0.15: ev.add("spy_against")
            if i >= 35 and self.r30:
                w = self.b[i - 35:i - 5]
                wh, wl = max(y[2] for y in w), min(y[3] for y in w)
                if (wh - wl) / c < 0.5 * self.r30 and (c > wh if bet > 0 else c < wl): ev.add("tight_break")
            o = self.b[0][1]
            if i >= 5 and bet * (c / o - 1) >= 0.005:
                rp = lambda j: ((self.b[j][4] - self.lo[j]) / (self.hi[j] - self.lo[j]) if bet > 0 else (self.hi[j] - self.b[j][4]) / (self.hi[j] - self.lo[j])) if self.hi[j] > self.lo[j] else None
                now = ((c - lo) / (hi - lo) if bet > 0 else (hi - c) / (hi - lo)) if hi > lo else None
                past = rp(i - 5)
                if past is not None and now is not None and past <= 0.6 and now >= past + 0.15: ev.add("pullback_turn")
            if m - last_ext >= 10: ev.add("stall10")
            if m - last_ext >= 20: ev.add("stall20")
            if i >= 10:
                tv = [self.typ[y[6]] for y in self.b[i - 9:i + 1] if self.typ[y[6]]]
                if tv and sum(y[5] for y in self.b[i - 9:i + 1]) < 0.8 * sum(tv): ev.add("vol_dry")
            self.vwap.append(vw); self.hi.append(hi); self.lo.append(lo); self.events.append(ev)

    def recent(self, minute, window=10):
        """Events fired in bars that closed in (minute - window, minute] -> minutes ago of the latest."""
        out = {}
        for i in range(max(0, minute - window), min(minute, len(self.events))):
            for e in self.events[i]:
                out[e] = minute - (i + 1)
        return out


ENTRY = ["vol3", "vol5", "new_high", "or_break", "prev_break", "vwap_cross", "rs_jump", "tight_break", "pullback_turn"]
EXIT = ["stall10", "stall20", "vwap_lost", "rs_drop", "spy_against", "vol_dry"]
rows = list(csv.DictReader(open(f"{d}/actions.csv")))
by = collections.defaultdict(list)
for r in rows:
    und, expiry, sr = r["contract"].rsplit(" ", 2)
    if r["account"] == "silexx" and not sr.endswith("S") and r["time_from"]:
        by[r["trade"]].append(r)
random.seed(11)
days = {}


def day(und, date, bet):
    k = (und, date, bet)
    if k not in days:
        days[k] = Day(und, date, bet)
    return days[k]


def minute_of(t):
    h, m, s = map(int, t.split(":"))
    return h * 60 + m - 570 + (1 if s else 0)


ent, ectl, ext, xctl = [], [], [], []
for trade, steps in by.items():
    und, expiry, sr = steps[0]["contract"].rsplit(" ", 2)
    bet = 1 if sr.endswith("C") else -1
    for s in steps:
        m = minute_of(s["time_from"])
        if not 1 <= m <= 390:
            continue
        D = day(und, s["date"], bet)
        if not D.ok:
            continue
        if s["action"] in ("open", "re-enter"):
            rec = D.recent(m)
            ent.append(dict(trade=trade, und=und, date=s["date"], time=s["time_from"], bet=bet, minute=m,
                            open15=int(m <= 15), late=int(m > 375), **{e: rec.get(e, "") for e in ENTRY}))
            for c in random.sample(range(1, 391), 20):
                rc = D.recent(c)
                ectl.append(dict(trade=trade, minute=c, open15=int(c <= 15), late=int(c > 375), **{e: rc.get(e, "") for e in ENTRY}))
    # exits: his sells vs minutes he held without acting, same day
    for date in sorted({s["date"] for s in steps}):
        day_steps = [s for s in steps if s["date"] == date]
        D = day(und, date, bet)
        if not D.ok:
            continue
        acted = {minute_of(s["time_from"]) for s in day_steps}
        first = min(acted) if date == steps[0]["date"] else 1
        sells = [s for s in day_steps if s["side"] == "S"]
        last = max(minute_of(s["time_from"]) for s in sells) if sells else 390
        for s in sells:
            m = minute_of(s["time_from"])
            if 1 <= m <= 390:
                rc = D.recent(m)
                ext.append(dict(trade=trade, date=date, time=s["time_from"], action=s["action"], minute=m,
                                **{e: rc.get(e, "") for e in EXIT + ENTRY}))
        for c in range(first + 1, last):
            if all(abs(c - a) > 2 for a in acted):
                rc = D.recent(c)
                xctl.append(dict(trade=trade, minute=c, **{e: rc.get(e, "") for e in EXIT + ENTRY}))


def write(path, data):
    keys = list(dict.fromkeys(k for x in data for k in x))
    w = csv.DictWriter(open(path, "w"), fieldnames=keys)
    w.writeheader(); w.writerows(data)


write(f"{d}/triggers_entries.csv", ent)
write(f"{d}/triggers_exits.csv", ext)


def rate(rows_, e, win=10):
    return sum(1 for r in rows_ if r[e] != "" and int(r[e]) < win) / len(rows_)


print(f"ENTRIES: {len(ent)} vs {len(ectl)} random minutes (same stock/day/direction)")
print(f"{'event':14} {'his entries':>11} {'random':>8} {'lift':>6}   minutes before (median)")
for e in ENTRY + ["open15", "late"]:
    a, b = (rate(ent, e) if e not in ("open15", "late") else sum(r[e] for r in ent) / len(ent),
            rate(ectl, e) if e not in ("open15", "late") else sum(r[e] for r in ectl) / len(ectl))
    ago = [int(r[e]) for r in ent if e in ENTRY and r[e] != ""]
    print(f"{e:14} {a:11.0%} {b:8.0%} {a / b if b else float('nan'):6.2f}   {st.median(ago) if ago else ''}")
for win in (3, 5):
    print(f"within {win} min: " + ", ".join(f"{e} {rate(ent, e, win):.0%}/{rate(ectl, e, win):.0%}" for e in ENTRY))
combo = collections.Counter(tuple(sorted(e for e in ENTRY if r[e] != "")) for r in ent)
cctl = collections.Counter(tuple(sorted(e for e in ENTRY if r[e] != "")) for r in ectl)
print("\nmost common event sets before his entries (share of entries / of random minutes):")
for k, v in combo.most_common(14):
    print(f"  {v / len(ent):5.1%} {cctl[k] / len(ectl):6.1%}  {' + '.join(k) or '(none)'}")
print(f"\nEXITS: {len(ext)} sells vs {len(xctl)} held-without-acting minutes")
print(f"{'event':14} {'his sells':>9} {'holding':>8} {'lift':>6}")
for e in EXIT + ["new_high", "vol3", "rs_jump"]:
    a, b = rate(ext, e), rate(xctl, e)
    print(f"{e:14} {a:9.0%} {b:8.0%} {a / b if b else float('nan'):6.2f}")
