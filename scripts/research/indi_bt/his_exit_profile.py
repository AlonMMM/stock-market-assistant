"""How he exits, split into profit-takes and loss-cuts. Main account, his 40 stocks, Feb 2024 - Oct 2026.

Every sell step is priced against his average cost at that moment: above it = a profit-take, at or below = a
loss-cut; "expired (assumed 0)" = he let it expire. Per trade: how he got out of losers (how deep, how soon,
same day or after a night) and how he took profit on winners (first take, share sold, nights held).

  python3 his_exit_profile.py      (from the repo root) -> data/local/x/bt/his_exit_steps.csv + printed tables
"""
import collections, csv, datetime as dt, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, "params.json")))
B = "data/local/x/bt"


def mins(d, t):
    hh, mm = map(int, t[:5].split(":")); return hh * 60 + mm - 570


def trades():
    T = collections.OrderedDict()
    for y in ("2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx": continue
            und, exp, sr = r["contract"].rsplit(" ", 2)
            if und not in P["universe"] or sr.endswith("S") or r["date"] < "2024-02-01": continue
            T.setdefault(r["trade"], []).append(r)
    return T


def main():
    T = trades(); steps, out = [], []
    for tid, rs in T.items():
        if rs[0]["action"] != "open" or not rs[0]["time_from"]: continue
        d0, m0 = rs[0]["date"], mins(rs[0]["date"], rs[0]["time_from"])
        cost, pos, avg, pnl, buys = 0.0, 0.0, 0.0, 0.0, 0
        sells = []
        for r in rs:
            q, p = float(r["qty"] or 0), float(r["avg_price"] or 0)
            if r["side"] == "B" and r["action"] in ("open", "add", "re-enter"):
                avg = (avg * pos + p * q) / (pos + q) if pos + q else p; pos += q; cost += q * p * 100; buys += 1
            elif r["side"] == "S" and pos > 0:
                ret = p / avg - 1 if avg else -1
                kind = "expired" if r["action"].startswith("expired") else ("take" if ret > 0 else "cut")
                nights = len({x["date"] for x in rs if x["date"] <= r["date"]}) - 1
                held = (mins(r["date"], r["time_from"]) - m0) if nights == 0 and r["time_from"] else None
                s = dict(trade=tid, date=r["date"], kind=kind, ret=ret, share=min(1, q / pos), nights=nights, held=held,
                         tod=mins(r["date"], r["time_from"]) if r["time_from"] else None, pnl=float(r["realized_step"] or 0))
                sells.append(s); steps.append(s); pos -= q
            if r["realized_step"]: pnl += float(r["realized_step"])
        if not sells or not cost: continue
        out.append(dict(trade=tid, year=d0[:4], ret=pnl / cost, pnl=pnl, adds=buys - 1, sells=sells, nights=max(s["nights"] for s in sells)))
    with open(f"{B}/his_exit_steps.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(steps[0])); w.writeheader(); w.writerows(steps)
    W = [t for t in out if t["pnl"] > 0]; L = [t for t in out if t["pnl"] <= 0]
    print(f"{len(out)} trades: {len(W)} winners ({sum(t['pnl'] for t in W)/1e6:+.2f}M), {len(L)} losers ({sum(t['pnl'] for t in L)/1e6:+.2f}M)\n")
    med = lambda xs: st.median(xs) if xs else float("nan")
    # ---- losers ----
    print("### Losers: how he got out\n\n| Way out | Trades | His real | Median return | Median minutes held | Share of losers |\n|---|---|---|---|---|---|")
    def how(t):
        k = [s["kind"] for s in t["sells"]]
        if "expired" in k: return "let it expire"
        if t["nights"] == 0: return "cut the same day"
        return "cut after 1+ nights"
    for lab in ("cut the same day", "cut after 1+ nights", "let it expire"):
        g = [t for t in L if how(t) == lab]
        hl = [s["held"] for t in g for s in t["sells"][-1:] if s["held"] is not None]
        print(f"| {lab} | {len(g)} | {sum(t['pnl'] for t in g)/1e6:+.2f}M | {100*med([t['ret'] for t in g]):+.0f}% | {med(hl):.0f} | {100*len(g)/len(L):.0f}% |")
    print("\n| Loser's final return | Trades | His real |\n|---|---|---|")
    for a, b, lab in ((-9, -0.75, "worse than -75%"), (-0.75, -0.5, "-75% to -50%"), (-0.5, -0.3, "-50% to -30%"), (-0.3, -0.15, "-30% to -15%"), (-0.15, 0.001, "-15% to 0")):
        g = [t for t in L if a < t["ret"] <= b]
        print(f"| {lab} | {len(g)} | {sum(t['pnl'] for t in g)/1e6:+.2f}M |")
    cuts = [s for t in L for s in t["sells"] if s["kind"] == "cut" and s["held"] is not None]
    print(f"\nSame-day loss-cut steps: {len(cuts)}, median {100*med([s['ret'] for s in cuts]):+.0f}% after {med([s['held'] for s in cuts]):.0f} min; "
          f"first 20 min: {sum(s['held'] <= 20 for s in cuts)}; partial (< all): {sum(s['share'] < 0.99 for s in cuts)}")
    # ---- winners ----
    print("\n### Winners: how he took profit\n\n| | Trades | His real | Median final return |\n|---|---|---|---|")
    def wh(t):
        if t["nights"] == 0: return "all out the same day"
        same = sum(s["share"] for s in t["sells"] if s["nights"] == 0)
        return "part the same day, rest after a night" if any(s["nights"] == 0 for s in t["sells"]) else "everything held overnight"
    for lab in ("all out the same day", "part the same day, rest after a night", "everything held overnight"):
        g = [t for t in W if wh(t) == lab]
        print(f"| {lab} | {len(g)} | {sum(t['pnl'] for t in g)/1e6:+.2f}M | {100*med([t['ret'] for t in g]):+.0f}% |")
    ft = [next((s for s in t["sells"] if s["kind"] == "take"), None) for t in W]; ft = [s for s in ft if s]
    print(f"\nFirst profit-take: median +{100*med([s['ret'] for s in ft]):.0f}%, sells median {100*med([s['share'] for s in ft]):.0f}% of the position, "
          f"same day {sum(s['nights']==0 for s in ft)} of {len(ft)}, median {med([s['held'] for s in ft if s['held'] is not None]):.0f} min after entry")
    print("\n| First take at | Winners | His real | Median share sold | Median final return |\n|---|---|---|---|---|")
    for a, b, lab in ((0, 0.25, "< +25%"), (0.25, 0.5, "+25-50%"), (0.5, 1, "+50-100%"), (1, 2, "+100-200%"), (2, 99, ">= +200%")):
        g = [(t, s) for t in W for s in [next((x for x in t["sells"] if x["kind"] == "take"), None)] if s and a <= s["ret"] < b]
        print(f"| {lab} | {len(g)} | {sum(t['pnl'] for t, s in g)/1e6:+.2f}M | {100*med([s['share'] for t, s in g]):.0f}% | {100*med([t['ret'] for t, s in g]):+.0f}% |")
    print(f"\nWinners with adds: {sum(t['adds']>0 for t in W)} of {len(W)}; losers with adds: {sum(t['adds']>0 for t in L)} of {len(L)}")
    print(f"Median sells per winner: {med([len(t['sells']) for t in W])}, per loser: {med([len(t['sells']) for t in L])}")


if __name__ == "__main__":
    main()
