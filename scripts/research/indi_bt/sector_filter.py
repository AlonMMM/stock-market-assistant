"""The sector filter on bot trades: skip a trade when, at its entry minute, the stock's sector ETF or its peers
(the other stocks of the universe on the same ETF, averaged) are down >= 0.5% against the bet since yesterday's
close. Reported for all stocks and, on the 191-stock universe, for the 151 stocks outside his 40 (stocks the
rule was not found on).

  node --env-file=.env scripts/research/indi_bt/run.mjs sector_filter.py fetch
  python3 sector_filter.py <trades prefix> [threshold]      e.g. w_flat, t_flat_n100   (from the repo root)
"""
import collections, csv, glob, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series
import context

B = "data/local/x/bt"
WIDE = {  # sector ETF of the 151 stocks outside his 40 (hand-made: S&P sector, semis -> SMH, software -> IGV)
    "IGV": "ADBE CRM INTU ADSK ANSS CDNS SNPS CRWD DDOG FTNT MDB PANW TEAM WDAY ZS TTD ROP",
    "SMH": "INTC TXN ADI ASML GFS KLAC LRCX MCHP MRVL NXPI ON",
    "XLK": "ACN CSCO CDW CTSH ADP PAYX",
    "XLF": "AIG AXP BAC BK BLK C COF GS JPM MA MET MS SCHW USB V WFC PYPL",
    "XLE": "COP CVX XOM BKR FANG",
    "XLV": "ABBV ABT AMGN BMY CVS DHR GILD JNJ LLY MDT MRK PFE TMO UNH AZN BIIB DXCM GEHC IDXX ILMN ISRG REGN VRTX",
    "XLY": "BKNG HD LOW MCD NKE SBUX F GM LULU MAR ORLY ROST ABNB DLTR MELI",
    "XLP": "CL COST KO MDLZ MO PEP PG PM WMT KHC KDP MNST WBA TGT CCEP",
    "XLI": "CAT DE EMR FDX GD GE HON LMT MMM RTX UNP UPS CSX CTAS CPRT FAST ODFL PCAR VRSK",
    "XLU": "DUK NEE SO AEP CEG EXC XEL",
    "XLB": "DOW LIN",
    "XLRE": "AMT SPG CSGP",
    "XLC": "CHTR CMCSA DIS NFLX T TMUS VZ EA TTWO WBD SIRI",
}
ETF_OF = {s: etf for etf, ss in WIDE.items() for s in ss.split()}
ETF_OF.update({s: etf for s, (g, etf) in context.SECT.items()})


def fetch():
    from store import fetch_bars
    import datetime as dt
    new = ["XLF", "XLE", "XLV", "XLP", "XLU", "XLB", "XLRE"]
    d = dt.date(2024, 1, 1)
    while d.isoformat() <= "2026-10-12":
        e = min((d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1), dt.date(2026, 10, 12))
        fetch_bars("stocks", new, d.isoformat(), e.isoformat()); print(d.isoformat()[:7], flush=True)
        d = e + dt.timedelta(days=1)


def main(prefix, th=0.5):
    cal = calendar(); idx = {d: i for i, d in enumerate(cal)}
    uni = P["universe_wide"] if prefix.startswith("w") else P["universe"]
    peers_of = collections.defaultdict(list)
    for s in uni: peers_of[ETF_OF[s]].append(s)
    T = [t for f in sorted(glob.glob(f"{B}/{prefix}_20*_trades.csv")) for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    def mv(x, d, m):
        b = day(x, d); pb = day(x, cal[idx[d] - 1])
        if len(b) < 100 or not pb: return None
        c = series(b)[0]
        return (c[m] / pb[-1][4] - 1) * 100 if c[m] else None
    out = []
    for t in T:
        d, s, m = t["date"], t["sym"], int(t["minute"]); bet = 1 if t["right"] == "C" else -1
        etf = ETF_OF[s]; se = mv(etf, d, m)
        pm = [v for v in (mv(p, d, m) for p in peers_of[etf] if p != s) if v is not None]
        against = (se is not None and bet * se <= -th) or (pm and bet * st.fmean(pm) <= -th)
        out.append(dict(year=d[:4], sym=s, his40=s in json.load(open(os.path.join(HERE, "params.json")))["universe"], pnl=float(t["pnl"]), against=bool(against)))
    print(f"{prefix}: {len(out)} trades, filter at {th}%\n")
    print("| Stocks | Year | All: trades, per trade, total | Kept | Skipped |\n|---|---|---|---|---|")
    groups = [("all", lambda r: True)] + ([("151 outside his 40", lambda r: not r["his40"]), ("his 40", lambda r: r["his40"])] if prefix.startswith("w") else [])
    for gname, gf in groups:
        for y in ("2024", "2025", "2026", "2025-26"):
            g = [r for r in out if gf(r) and (r["year"] == y or (y == "2025-26" and r["year"] > "2024"))]
            cell = lambda xs: f"{len(xs)}, {st.fmean(xs):+,.0f}, {sum(xs)/1e3:+,.0f}K" if xs else "0"
            print(f"| {gname} | {y} | {cell([r['pnl'] for r in g])} | {cell([r['pnl'] for r in g if not r['against']])} | {cell([r['pnl'] for r in g if r['against']])} |")


if __name__ == "__main__":
    if sys.argv[1] == "fetch": fetch()
    else: main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 0.5)
