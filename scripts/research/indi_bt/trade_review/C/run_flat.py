"""Follow-up to group C (2026-11-03): the user, on the task 11 lead: "go with the stock - if it start to be flat we can
exit." Judge the fade by the STOCK: after the buy, if the stock has not moved the trade's way, exit early.

Built on Volume 1.2.0 + the broker's -80% stop (exitlab.py, the same re-walk that reproduces all 155 engine trades).
Levels set BEFORE the run:
  flat = at the close of minute buyMinute + W, the stock's move from the side price in the trade's direction
         (close vs stockIn, in S30 units) is < X; then sell at that minute's bid (the minute book, real).
  W in {3, 5, 10} minutes, X in {0.25, 0.5} S30.
  Scope: shock trades only (the thesis), all trades (neighbour).
  Confirm: none (the thesis) / only if the option bid is also <= the price paid (neighbour).
  => 24 versions; one pick per scope (shock / all) on tune by the 2% account, ties by w/o best 5; check only the picks.
  Reference row (post-hoc, from the group C run): B5 = shock, volume < 3x usual for 5 min after the alert, sell at +5
  min if the bid <= paid.
Run: python3 run_flat.py > out/flat.txt
"""
import run_exits as R
from exitlab import walk
from acct import load, half

VERS = [('base: 1.2.0 + -80% stop', {})]
for scope in ('shock', 'all'):
    for need in (False, True):
        for W in (3, 5, 10):
            for X in (0.25, 0.5):
                VERS.append((f"{scope} W{W} X{X}{' +bid<=paid' if need else ''}", dict(flat=(W, X, scope, need))))
VERS.append(('B5 (post-hoc) vol < 3x 5 min, cut if <= paid', dict(fade='cut', fadeX=3.0)))


def main():
    sets = {i: (n, R.apply(v, n)) for i, (n, v) in enumerate(VERS)}
    base = sets[0][1]
    tune = {i: R.stats(s, 'tune') for i, (n, s) in sets.items()}
    picks = {}
    for scope in ('shock', 'all'):
        keys = [i for i, (n, _) in sets.items() if n.startswith(scope + ' ')]
        picks[scope] = max(keys, key=lambda i: (tune[i]['e2'], tune[i]['wo5']))
    pk = set(picks.values())
    print("## Tune (even ISO entry weeks), 2% (3%)\n" + R.HEAD)
    for i, (n, _) in sets.items():
        print(R.row(n, tune[i], ' 🎯' if i in pk else ''))
    last = len(VERS) - 1
    for view in ('check', 'year'):
        print(f"\n## {view.capitalize()}: the base, the picks, B5\n" + R.HEAD)
        for i in [0] + sorted(pk) + [last]:
            print(R.row(sets[i][0], R.stats(sets[i][1], view), ' 🎯' if i in pk else ''))
    print("\n## What changes vs the base (account's taken trades, flat $2K)")
    for i in sorted(pk) + [last] + [i for i in sets if i not in pk and i not in (0, last)]:
        n, sigs = sets[i]
        for view in ('tune', 'check'):
            ch, better, cut = R.changed(base, sigs, view)
            d = 2000 * sum(b - a for _, a, b, _ in ch)
            print(f"  {n} [{view}]: {len(ch)} differ, {better} better, flat {R.k(d)}; giants cut {len(cut)}: " +
                  ", ".join(f"{x.split('|')[0]} {x.split('|')[1][5:]} {100*a:+.0f}%->{100*b:+.0f}%" for x, a, b in cut))
    print("\n## The picks, trade by trade (year)")
    bt = {s['id']: s['trade'] for s in base if s.get('trade')}
    for i in sorted(pk):
        for s in sets[i][1]:
            if s.get('trade') and (s['trade']['sell'] != bt[s['id']]['sell'] or s['trade']['exitMinute'] != bt[s['id']]['exitMinute']):
                a, b = bt[s['id']], s['trade']
                print(f"  {sets[i][0]}: {s['id']} {half(s['date'])} buy {a['buy']:.2f} base m{a['exitMinute']} {a['sell']:.2f} ({100*R.ret(a):+.0f}%) -> m{b['exitMinute']} {b['sell']:.2f} ({100*R.ret(b):+.0f}%)")
    print(f"\nGaps: {len(R.GAPS)}", R.GAPS[:10])


if __name__ == '__main__':
    main()
