# The user, 2026-11-02: "can you ran Half if > 200% for all 3 years?" The 3-year twin's trades (top50, live): the bought
# contract is found in the research's Databento minute books (same stock, side, the expiry nearest, the book at the buy
# minute closest to the price paid), then its ask 5 minutes before (row m = the book as minute m began, as the app).
import csv, sys, json, re
import real_bench as RB
rows = [r for r in csv.DictReader(open(sys.argv[1])) if r['list'] == 'top50' and r['version'] == 'live' and r['size'] == '2' and r['view'] == 'all']
out, miss, far = {}, 0, 0
for r in sorted(rows, key=lambda r: r['date']):
    m, buy = int(r['minute']), float(r['buy'])
    bk = RB.book(r['date'])
    best = None
    for c, v in bk.items():
        g = re.match(r'([A-Z]+)(\d{6})([CP])', c)
        if not g or g.group(1) != r['sym'] or g.group(3) != r['side']: continue
        at = [x for x in v if m - 3 <= x[0] <= m + 2]
        if not at: continue
        d = min(abs(x[2] - buy) / buy for x in at)
        if best is None or d < best[0]: best = (d, c, v)
    if not best: miss += 1; continue
    if best[0] > 0.15: far += 1
    d, c, v = best
    def ask(mm):
        a = [x for x in v if x[0] <= mm]
        return a[-1][2] if a and mm - a[-1][0] < 5 and a[-1][2] > 0 else None
    k = (r['date'], r['sym'], r['minute'], r['side'])
    out['|'.join(k)] = {'c': c, 'match': d, **{str(n): (buy / ask(m - n) - 1 if ask(m - n) else None) for n in (1, 5, 10, 15)}}
json.dump(out, open(sys.argv[2], 'w'))
v5 = [x['5'] for x in out.values() if x['5'] is not None and x['match'] <= 0.15]
print(len(rows), 'trades; matched', len(out), 'none', miss, 'match > 15% off', far, '; with a 5-min-back ask', len(v5), '; > 200%:', sum(x > 2 for x in v5))
