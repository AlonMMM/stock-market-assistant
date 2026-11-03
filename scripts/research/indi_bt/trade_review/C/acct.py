# A line-by-line port of the app's volumeAccount (packages/trading/src/strangle/backtest.ts, origin/main 6f0cf09):
# a stock's trades of a day in alert order, one at a time, up to maxPerStock; then each day in buy order, sized from
# the morning's account, with the live limits (day loss, trades a day, open trades). Worst drop on closed trades.
import json, os, datetime as dt

FEE = 0.62
SAVED = dict(maxPerStock=2, maxTradesPerDay=15, maxOpen=5, dayLossPct=7.5)


def week(d):
    return dt.date.fromisoformat(d).isocalendar()[1]


def half(d):
    return 'tune' if week(d) % 2 == 0 else 'check'


def ret(t):
    return (t['sell'] * 100 - FEE) / (t['buy'] * 100 + FEE) - 1


def account(sigs, size, limits=True, start=100_000.0):
    """sigs: signals with 'trade' (buy, sell, buyMinute, exitMinute). -> dict(end, drop, taken=[(sig, qty, pnl, ret)])"""
    by = {}
    for s in sigs:
        if s.get('trade'):
            by.setdefault((s['date'], s['symbol']), []).append(s)
    kept = []
    for lst in by.values():
        busy, n = -1, 0
        for s in sorted(lst, key=lambda s: s['second']):
            t = s['trade']
            if t['buyMinute'] <= busy or n >= SAVED['maxPerStock']:
                continue
            kept.append(s); busy = t['exitMinute']; n += 1
    days = {}
    for s in kept:
        days.setdefault(s['date'], []).append(s)
    eq = peak = start; drop = 0.0; taken = []
    for d in sorted(days):
        st = eq; done = []; today = []
        for s in sorted(days[d], key=lambda s: (s['trade']['buyMinute'], s['minute'])):
            t = s['trade']
            if limits:
                if sum(x[1] for x in done if x[0] < t['buyMinute']) <= -SAVED['dayLossPct'] / 100 * st: continue
                if len(done) >= SAVED['maxTradesPerDay']: continue
                if sum(1 for x in done if x[0] >= t['buyMinute']) >= SAVED['maxOpen']: continue
            q = int((size / 100 * st) // (t['buy'] * 100))
            if q < 1: continue
            pnl = q * (t['sell'] - t['buy']) * 100 - FEE * 2 * q
            done.append((t['exitMinute'], pnl)); today.append((s, q, pnl, ret(t)))
        for x in sorted(today, key=lambda x: x[0]['trade']['exitMinute']):
            eq += x[2]; peak = max(peak, eq); drop = max(drop, 1 - eq / peak)
        taken += today
    return dict(end=eq, drop=drop * 100, taken=taken)


def load(dirn, tag):
    out = []
    for f in sorted(os.listdir(dirn)):
        if f.startswith(tag + '_'):
            out += json.load(open(os.path.join(dirn, f)))['signals']
    return out
