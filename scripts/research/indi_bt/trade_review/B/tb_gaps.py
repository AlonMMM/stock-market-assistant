# testB: the delayed variants' alerts with no book (buy windows / sale days), and the stock-chunks to re-run.
import json, glob, re, sys, collections
T, prefixes = sys.argv[1], sys.argv[2].split(',')
CH = ["2025-11-03", "2026-01-02", "2026-03-02", "2026-05-01", "2026-07-01", "2026-09-01"]
chunk = lambda d: [c for c in CH if c <= d][-1]
win, mins = set(), set()
for p in prefixes:
    redo = set()
    for f in glob.glob(f'{T}/runs/parts/{p}_*.json'):
        for s in json.load(open(f))['signals']:
            if s['outcome'] != 'no_fill': continue
            m1 = re.search(r'\((\S+) at (\d+)\)', s['detail']); m2 = re.search(r'\((\S+) day\)', s['detail'])
            if m1: win.add((s['date'], m1.group(1), int(m1.group(2))))
            if m2: mins.add((s['date'], m2.group(1)))
            redo.add((s['symbol'], chunk(s['date'])))
    json.dump(sorted(redo), open(f'{T}/redo_{p}.json', 'w'))
    print(p, 'chunks to re-run', len(redo))
json.dump(sorted(win), open(f'{T}/need_windows.json', 'w')); json.dump(sorted(mins), open(f'{T}/need_minutes.json', 'w'))
print('windows', len(win), 'sale days', len(mins))
