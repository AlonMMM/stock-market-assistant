"""The stock-flat exit's picks on 3 years (follow-up 2026-11-03, the user: "go with the stock - if it start to be flat
we can exit"). Levels fixed by run_flat.py's tune picks (no new levels here):
  P1 shock trades: at buy minute + 10, the stock < 0.25 S30 the trade's way AND the bid <= the price paid -> sell
  P2 all trades:   at buy minute + 5,  the stock < 0.5 S30 the trade's way -> sell
Trades: the 3-year research twin of Volume 1.1.0 ("Live (PR #204)" on the 10-30 dashboard: top 50, live limits,
2024-02 .. 2026-10, 431 trades at 2%; volume_trades.csv). The export has no contract and no side price, so:
  - the contract = the strike of the trade's side whose real minute bid at the exit minute is the export's sale
    (dbx_cache, every folder; ties: the book at the buy minute nearest the buy price); unresolved ones keep the base;
  - the side price = the close of the buy minute (proxy; on the year it moves both picks by <= $0.7K);
  - S30 = levels.ctx sd (the research's unit), stock bars from market.sqlite (read only).
Base = the export + the broker's -80% stop on the minute books (as the app engine). A variant changes a trade only
when its flat exit comes before the base exit. The account is re-walked from the export's dollars (each trade's
contracts from its P&L; the day's size scaled to the new account), slots are not refilled (as volume_against_hour_3y).
Run: cd <main checkout> && BT_DATA=data/local/x/bt python3 <testC>/flat3y.py <volume_trades.csv>
"""
import csv, gzip, glob, os, sys, statistics as st
from collections import defaultdict
from datetime import date as D
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'research/indi_bt'))
from store import day
from levels import ctx

CACHE = os.path.join(HERE, 'research/indi_bt/dbx_cache')
half = lambda d: 'tune' if D.fromisoformat(d).isocalendar()[1] % 2 == 0 else 'check'
_q = {}


def quotes(date, sym):
    if (date, sym) not in _q:
        _q.clear(); by = defaultdict(dict)
        for p in glob.glob(os.path.join(CACHE, f'{date}.csv.gz')) + glob.glob(os.path.join(CACHE, '*', f'{date}.csv.gz')):
            if '/oi/' in p: continue
            for line in gzip.open(p, 'rt'):
                if not line.startswith(sym): continue
                c, mm, b, a = line.split(',')[:4]
                r = dict(contract=c, minute=mm, bid=b, ask=a)
                if r['bid'] and r['ask'] and float(r['ask']) > 0:
                    by[r['contract']][int(r['minute'])] = (float(r['bid']), float(r['ask']))
        _q[(date, sym)] = {c: sorted((m, b, a) for m, (b, a) in v.items()) for c, v in by.items()}
    return _q[(date, sym)]


def book(rows, m):   # the book as minute m closed: row stamped <= m + 1, at most 5 minutes old (leg_realspread.quote)
    best = None
    for r in rows:
        if r[0] > m + 1: break
        best = r
    return best if best and best[0] >= m - 3 else None


def main():
    src = sys.argv[1]
    R = [r for r in csv.DictReader(open(src)) if r['list'] == 'top50' and r['version'] == 'live' and r['view'] == 'all' and r['size'] in ('2', '3')]
    T = {}
    for r in R:
        T.setdefault((r['date'], r['sym'], r['minute'], r['side']), {})[r['size']] = r
    trades, unresolved = [], []
    for key, sz in sorted(T.items()):
        r = sz['2'] if '2' in sz else sz['3']
        d, sym, side = r['date'], r['sym'], r['side']
        ct = int(r['minute']); h, mi = map(int, r['out'].split(':')); out = h * 60 + mi - 570
        buy, sell = float(r['buy']), float(r['sell'])
        Q = quotes(d, sym)
        if len(trades) % 50 == 0: print('..', len(trades), d, file=sys.stderr, flush=True)
        yymmdd = d[2:4] + d[5:7] + d[8:10]
        cands = []
        for c, rows in Q.items():
            if not c.startswith(sym) or c[len(sym):len(sym) + 6] < yymmdd or c[len(sym) + 6] != side or not c[len(sym)].isdigit(): continue
            q = book(rows, out)
            if q and abs(q[1] - sell) < 1e-6:
                qb = book(rows, ct)
                cands.append((abs((qb[1] + qb[2]) / 2 - buy) if qb else 9, c))
        x = ctx(sym, d); bars = {b[0]: b for b in day(sym, d)}
        t = dict(key=key, date=d, sym=sym, side=side, kind=r['alert'], ct=ct, out=out, buy=buy, sell=sell, rows=None,
                 unit=x['sd'] if x else None, bars=bars, sizes=sz)
        if cands and t['unit']:
            t['contract'] = min(cands)[1]; t['rows'] = Q[t['contract']]
        else:
            unresolved.append(key)
        trades.append(t)
    print(f"{len(trades)} trades, contract resolved {len(trades) - len(unresolved)}, unresolved {len(unresolved)} (kept as the base)")

    def exit_of(t, v):
        """-> (minute, sell, why): base = export + -80% stop; v = (W, X, scope, needBid) or None."""
        m, px, why = t['out'], t['sell'], 'export'
        if t['rows']:
            for s_, b, a in t['rows']:
                mm = s_ - 1
                if t['ct'] < mm < m and b <= 0.2 * t['buy']:
                    m, px, why = mm, b, 'stop'; break
            if v and (v[2] == 'all' or t['kind'] == 'shock'):
                W, X, _, need = v; tm = t['ct'] + W
                if tm < m and tm in t['bars'] and t['ct'] in t['bars']:
                    ref, spot = t['bars'][t['ct']][4], t['bars'][tm][4]
                    mv = ((spot / ref - 1) if t['side'] == 'C' else (1 - spot / ref)) / t['unit']
                    q = book(t['rows'], tm)
                    if mv < X and q and (not need or q[1] <= t['buy']):
                        return tm, q[1], 'flat'
        return m, px, why

    def account(v, size):
        rows = sorted([t for t in trades if size in t['sizes']], key=lambda t: (t['date'], t['ct']))
        eq0 = eq1 = 1e5; peak = 1e5; dd = 0.0; cur = None; out = []
        for t in rows:
            e = t['sizes'][size]
            if t['date'] != cur: cur, b0, b1 = t['date'], eq0, eq1
            p0 = float(e['pnl']); eq0 += p0
            den = (t['sell'] - t['buy']) * 100 - 1.24
            q = round(p0 / den) if abs(den) > 1e-9 else max(1, int(int(size) / 100 * b0 // (t['buy'] * 100)))
            m, px, why = exit_of(t, v)
            p = (q * (px - t['buy']) * 100 - 1.24 * q) * b1 / b0
            r = (px * 100 - 0.62) / (t['buy'] * 100 + 0.62) - 1
            eq1 += p; peak = max(peak, eq1); dd = max(dd, 1 - eq1 / peak)
            out.append((t, p, r, why))
        return eq1, dd * 100, out

    K = lambda n: f"${n / 1000:,.1f}K"
    k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1000:,.1f}K"
    VERS = [('base: twin + -80% stop', None), ('P1 shock W10 X0.25 +bid<=paid', (10, 0.25, 'shock', True)),
            ('P2 all W5 X0.5', (5, 0.5, 'all', False))]
    print("| Version | Trades | Won | Median | 2% (drop) | 3% (drop) | Tune / check P&L (2%) | W/o best 5 | Non-giant (flat $2K) | Giants | 2024 / 2025 / 2026 | 2025-10-10 | W/o 10-10 |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    base = None
    for name, v in VERS:
        e2, d2, o = account(v, '2'); e3, d3, _ = account(v, '3')
        rs = sorted(x[2] for x in o); ps = sorted((x[1] for x in o), reverse=True)
        hv = defaultdict(float); yr = defaultdict(float)
        for t, p, r, _ in o: hv[half(t['date'])] += p; yr[t['date'][:4]] += p
        ten = sum(p for t, p, _, _ in o if t['date'] == '2025-10-10')
        print(f"| {name} | {len(o)} | {sum(1 for x in o if x[1] > 0)} | {100 * rs[len(rs) // 2]:+.0f}% | {K(e2)} ({d2:.1f}%) | {K(e3)} ({d3:.1f}%) | "
              f"{k(hv['tune'])} / {k(hv['check'])} | {k(sum(ps[5:]))} | {k(2000 * sum(x for x in rs if x < 3))} | {sum(1 for x in rs if x >= 3)} | "
              f"{k(yr['2024'])} / {k(yr['2025'])} / {k(yr['2026'])} | {k(ten)} | {k(sum(ps) - ten)} |")
        if v is None: base = {t['key']: r for t, p, r, _ in o}
        else:
            ch = [(t, base[t['key']], r) for t, p, r, w in o if w == 'flat']
            for hf in ('tune', 'check'):
                c = [x for x in ch if half(x[0]['date']) == hf]
                cut = [x for x in c if x[1] >= 3]
                print(f"    {name} [{hf}]: {len(c)} trades cut, {sum(1 for x in c if x[2] > x[1])} better, flat {k(2000 * sum(x[2] - x[1] for x in c))}, "
                      f"median change {100 * st.median([x[2] - x[1] for x in c]) if c else 0:+.0f} pts; giants cut {len(cut)}: " +
                      ", ".join(f"{x[0]['sym']} {x[0]['date']} {100 * x[1]:+.0f}%->{100 * x[2]:+.0f}%" for x in cut))
    print("unresolved:", unresolved[:20])


if __name__ == '__main__':
    main()
