"""Runner for exitlab.py: tune table for every version, the pick per idea (on tune), check for the base and the picks.
python3 run_exits.py > out/run.txt"""
import copy, statistics as st, sys, json
from collections import Counter, defaultdict
import exitlab
from exitlab import walk, VARIANTS, IDEA, books, book_at, stock, two_sided
from acct import account, load, half, ret

ALL = load('year/parts', 'v12')
TR = [s for s in ALL if s.get('trade')]
GAPS = []   # (id, variant, why)


def apply(v, name):
    out = []
    for s in ALL:
        if not s.get('trade'):
            out.append(s); continue
        m, px, why = walk(s, v)
        if px is None:   # no book within 4 minutes of the exit minute: the next book's bid (listed as a gap)
            rows = books(s['trade']['contract'], s['date'])
            nxt = next((q for q in rows if q[0] >= m), None)
            GAPS.append((s['id'], name, f'no book at minute {m}'))
            px = nxt[1] if nxt else 0.0
        s2 = dict(s); s2['trade'] = dict(s['trade'], exitMinute=m, sell=px, exitReason=why)
        out.append(s2)
    return out


def roll(base_sigs, K):
    """D: a same-direction alert's trade while the stock's open trade is up >= K x: sell the open one at that minute's bid."""
    by = defaultdict(list)
    for s in base_sigs:
        if s.get('trade'): by[(s['date'], s['symbol'])].append(s)
    repl = {}
    events = []
    for lst in by.values():
        lst.sort(key=lambda s: s['second'])
        open_ = None; n = 0
        for s in lst:
            t = s['trade']
            if open_ is not None and t['buyMinute'] <= open_['trade']['exitMinute']:
                o = open_['trade']
                if t['right'] == o['right'] and n < 2:
                    q = book_at(books(o['contract'], s['date']), t['buyMinute'])
                    if q and two_sided(q) and q[1] >= K * o['buy']:
                        events.append((open_['id'], s['id'], o['buy'], o['sell'], q[1], t['buy'], t['sell']))
                        o2 = dict(o, exitMinute=t['buyMinute'] - 1, sell=q[1], exitReason='roll')
                        repl[open_['id']] = o2
                        open_ = s; n += 1
                continue
            if n >= 2: continue
            open_ = s; n += 1
    out = [dict(s, trade=repl[s['id']]) if s['id'] in repl else s for s in base_sigs]
    return out, events


def stats(sigs, view):
    ss = [s for s in sigs if view == 'year' or half(s['date']) == view]
    a2, a3 = account(ss, 2), account(ss, 3)
    tk = a2['taken']
    r = sorted(x[3] for x in tk)
    p = sorted((x[2] for x in tk), reverse=True)
    yr = defaultdict(float)
    for x in tk: yr[x[0]['date'][:4]] += x[2]
    return dict(n=len(tk), won=sum(1 for x in tk if x[2] > 0), med=r[len(r) // 2] if r else 0,
                e2=a2['end'], d2=a2['drop'], e3=a3['end'], d3=a3['drop'], wo5=sum(p[5:]),
                giants=sum(1 for x in r if x >= 3), nongiant=2000 * sum(x for x in r if x < 3),
                y25=yr['2025'], y26=yr['2026'], ids={x[0]['id']: x[3] for x in tk})


K = lambda n: f"${n / 1000:.1f}K"
k = lambda n: f"{'-' if n < 0 else '+'}${abs(n) / 1000:.1f}K"


def row(name, s, mark=''):
    return (f"| {name}{mark} | {s['n']} | {s['won']} | {100 * s['med']:+.0f}% | {K(s['e2'])} ({s['d2']:.0f}%) | "
            f"{K(s['e3'])} ({s['d3']:.0f}%) | {k(s['wo5'])} | {k(s['nongiant'])} | {s['giants']} | {k(s['y25'])} / {k(s['y26'])} |")


HEAD = ("| Version | Trades | Won | Median | 2% (drop) | 3% (drop) | W/o best 5 (2%) | Non-giant sum (flat $2K) | Giants (+300%) | "
        "2025 / 2026 (2% P&L) |\n|---|---|---|---|---|---|---|---|---|---|")


def changed(base, var, view='year'):
    """The account's taken trades (2%) of the variant vs the base: changed, added or dropped; flat $2K a trade."""
    b, v = stats(base, view)['ids'], stats(var, view)['ids']
    ch = [(i, b.get(i, 0.0), v.get(i, 0.0), (i in b) - (i in v)) for i in set(b) | set(v)
          if (i in b) != (i in v) or abs(b[i] - v[i]) > 1e-9]
    better = sum(1 for _, x, y, _ in ch if y > x)
    cut = [(i, x, y) for i, x, y, _ in ch if x >= 3 and y < x]
    return ch, better, cut


def main():
    sets = {}
    for i, (name, v) in enumerate(VARIANTS):
        sets[i] = (name, apply(v, name))
    base = sets[0][1]
    for K_, nm in ((3, 'D1 roll on a same-direction alert at >= 3x'), (2, 'D2 roll at >= 2x')):
        sigs, ev = roll(base, K_)
        sets['D%d' % (1 if K_ == 3 else 2)] = (nm, sigs)
        print(f"\n{nm}: {len(ev)} roll events (before the account's limits)")
        for e in ev:
            print(f"   {e[0]} -> {e[1].split('|')[2]} {e[1].split('|')[3]}: old {e[2]:.2f} -> engine sale {e[3]:.2f}, rolled at {e[4]:.2f}; new {e[5]:.2f} -> {e[6]:.2f}")

    tune = {key: stats(s, 'tune') for key, (n, s) in sets.items()}
    print("\n## Tune (even ISO entry weeks)\n" + HEAD)
    picks = {}
    for idea, keys in IDEA.items():
        cand = [kk for kk in keys]
        best = max(cand, key=lambda kk: (min(tune[kk]['e2'], 1e12), tune[kk]['wo5']))
        picks[idea] = best
    for key, (name, _) in sets.items():
        print(row(name, tune[key], ' 🎯' if key in picks.values() else ''))
    print("\n## Check (odd ISO entry weeks): the base and the picks\n" + HEAD)
    chk = {}
    for key in [0] + list(picks.values()) + [9]:   # 9 = B5, post-hoc, shown for the record
        chk[key] = stats(sets[key][1], 'check')
        print(row(sets[key][0], chk[key], ' 🎯' if key else ''))
    print("\n## Year (both halves, one account), the base and the picks\n" + HEAD)
    for key in [0] + list(picks.values()) + [9]:
        print(row(sets[key][0], stats(sets[key][1], 'year'), ' 🎯' if key else ''))

    print("\n## What each version changes vs the base (year, flat $2K a trade)")
    for key, (name, sigs) in sets.items():
        if key == 0: continue
        for view in ('tune', 'check'):
            ch, better, cut = changed(base, sigs, view)
            d = 2000 * sum(b - a for _, a, b, _ in ch)
            dm = st.median([b - a for _, a, b, _ in ch]) if ch else 0
            add = sum(1 for c in ch if c[3] == -1); drop = sum(1 for c in ch if c[3] == 1)
            print(f"  {name} [{view}]: {len(ch)} trades differ ({add} added, {drop} dropped), {better} better, flat {k(d)}, median change {100 * dm:+.0f} pts; "
                  f"giants cut {len(cut)}: " + ", ".join(f"{i.split('|')[0]} {i.split('|')[1][5:]} {100 * a:+.0f}%->{100 * b:+.0f}%" for i, a, b in cut[:6]))

    # the -80% stop: fired on a stale or missing quote?
    print("\n## The base's -80% stops: the book that fired them")
    for s in TR:
        info = {}
        m, px, why = walk(s, {}, info)
        if why != 'stop': continue
        q = info['stop_row']; prev = info['stop_prev']
        rows = books(s['trade']['contract'], s['date'])
        later = [r for r in rows if q[0] < r[0] <= q[0] + 15 and two_sided(r)]
        back = max((r[1] for r in later), default=None)
        sb = stock(s['symbol'], s['date']); spot = sb.get(m, [0] * 5)[4]
        t = s['trade']
        mv = ((spot / t['stockIn'] - 1) if t['right'] == 'C' else (1 - spot / t['stockIn'])) / s['unit']
        flags = []
        if not (q[1] > 0 and q[2] > 0): flags.append('one-sided')
        elif not two_sided(q): flags.append('wide>50%')
        if prev is None or q[0] - prev > 3: flags.append(f'gap {q[0] - (prev or t["buyMinute"])} min')
        flags.append(f'best bid next 15 min {back:.2f} = {100 * (back / t["buy"] - 1):+.0f}% of the buy' if back else 'no book next 15 min')
        print(f"  {s['id']} {t['contract']} buy {t['buy']:.2f} stop at m{m} (+{m - t['buyMinute']} min) book {q[1]}/{q[2]} "
              f"stock {mv:+.2f} S30 vs entry; engine exit {t['exitMinute']} {t['sell']:.2f} | {' '.join(flags) or 'clean'}")

    fad = Counter()
    for s in TR:
        if s['kind'] == 'shock':
            fad[exitlab.faded(s)] += 1
    print(f"\nShock trades by fade (5 min after the alert minute, < 2x usual): {dict(fad)}; < 3x: {dict(Counter(exitlab.faded(s, X=3.0) for s in TR if s['kind'] == 'shock'))}")
    print(f"\nGaps (no book within 4 min at a variant's exit; the next book's bid used): {len(GAPS)}")
    for g in GAPS: print('  ', g)
    miss = Counter(s['outcome'] for s in ALL if s['outcome'] in ('no_fill', 'no_prices'))
    print(f"Alerts with missing data in the base run (engine outcomes): {dict(miss)}")
    for s in ALL:
        if s['outcome'] in ('no_fill',): print('   ', s['id'], s['outcome'], s['detail'])
    print("\n## Trade by trade where a variant differs (B, C; year)")
    bt = {s['id']: s['trade'] for s in base if s.get('trade')}
    for key in [5, 7, 9, 10, 11, 12, 13]:
        name, sigs = sets[key]
        for s in sigs:
            if not s.get('trade'): continue
            a, b = bt[s['id']], s['trade']
            if a['sell'] != b['sell'] or a['exitMinute'] != b['exitMinute']:
                print(f"  {name}: {s['id']} {half(s['date'])} buy {a['buy']:.2f} base {a['exitReason']} m{a['exitMinute']} {a['sell']:.2f} ({100*ret(a):+.0f}%) -> {b['exitReason']} m{b['exitMinute']} {b['sell']:.2f} ({100*ret(b):+.0f}%)")
    json.dump({str(kk): [sets[kk][0], [dict(id=s['id'], **{x: s['trade'][x] for x in ('buy', 'sell', 'exitMinute', 'exitReason')}) for s in sets[kk][1] if s.get('trade')]] for kk in sets},
              open('out/trades.json', 'w'))


if __name__ == '__main__':
    main()
