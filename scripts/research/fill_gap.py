# Helper for hand transcription: given visible fills and Portfolio totals, append one inferred fill per (contract, side)
# for rows hidden off-screen. rows: (time, side, qty, contract, price); totals: {contract: (bq, bavg, sq, savg)}; gap: {(contract, side): time}
import sys
def emit(head, rows, totals, gap, tail=()):
    out = list(head)
    for (c, s), t in gap.items():
        bq, ba, sq, sa = totals[c]
        tq, ta = (bq, ba) if s == "B" else (sq, sa)
        vis = [r for r in rows if r[3] == c and r[1] == s]
        q = sum(r[2] for r in vis); v = sum(r[2] * r[4] for r in vis)
        hq = tq - q
        if hq > 0:
            hp = round((tq * ta - v) / hq, 4)
            print(f"{c} {s}: hidden {hq} @ {hp}", file=sys.stderr)
            rows = rows + [(t, s, hq, c, hp)]
            out.append(f"N {c}: {hq} {'bought' if s == 'B' else 'sold'} in rows not shown on the screenshots, inferred from Portfolio totals")
    out += [f"F {t} {s} {q} {c} {p}" for t, s, q, c, p in rows]
    out += list(tail)
    print("\n".join(out))
