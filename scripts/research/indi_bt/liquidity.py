"""Option liquidity screen for the wide stock list (his 40 + S&P 100 + Nasdaq-100 as of Jan 2024).

Per stock:
  spread   median (ask - bid) / mid of today's OPRA quotes on contracts 1-10 days out with
           |delta| 0.10-0.25 (live snapshot; history of quotes is not available)
  volume   average daily volume of all contracts in the nearest expiry 1-10 days out with strikes
           within 10% of the stock, on 2024-01-10, -17 and -24 (before the test period)

  node --env-file=.env scripts/research/indi_bt/run.mjs liquidity.py   -> data/local/x/bt/liquidity.csv
"""
import csv, datetime as dt, os, statistics as st, urllib.error, urllib.parse
from store import P, DATA, _get, expiries, chain, occ, delta

SP100 = """AAPL ABBV ABT ACN ADBE AIG AMD AMGN AMT AMZN AVGO AXP BA BAC BK BKNG BLK BMY C CAT CHTR CL CMCSA
COF COP COST CRM CSCO CVS CVX DE DHR DIS DOW DUK EMR F FDX GD GE GILD GM GOOGL GS HD HON IBM INTC INTU JNJ
JPM KHC KO LIN LLY LMT LOW MA MCD MDLZ MDT MET META MMM MO MRK MS MSFT NEE NFLX NKE NVDA ORCL PEP PFE PG PM
PYPL QCOM RTX SBUX SCHW SO SPG T TGT TMO TMUS TSLA TXN UNH UNP UPS USB V VZ WFC WMT XOM""".split()
NDX = """ADI ADP ADSK AEP ANSS ASML AZN BIIB BKR CDNS CDW CEG CPRT CRWD CSGP CSX CTAS CTSH DDOG DLTR DXCM EA EXC
FANG FAST FTNT GEHC GFS IDXX ILMN ISRG KDP KLAC LRCX LULU MAR MCHP MDB MELI MNST MRNA MRVL MU NXPI ODFL ON
ORLY PANW PAYX PCAR PDD REGN ROP ROST SIRI SNPS TEAM TTD TTWO VRSK VRTX WBA WBD WDAY XEL ZS ABNB CCEP""".split()
WIDE = list(dict.fromkeys(P["universe"] + SP100 + NDX))
DATES = ["2024-01-10", "2024-01-17", "2024-01-24"]


def stock_close(syms, date):
    out = {}
    for i in range(0, len(syms), 100):
        q = dict(symbols=",".join(syms[i:i + 100]), timeframe="1Day", start=date, end=date, feed="sip", adjustment="raw")
        for s, b in (_get("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(q)).get("bars") or {}).items():
            out[s] = b[0]["c"]
    return out


def hist_volume(und, date, spot):
    try:
        return _hist_volume(und, date, spot)
    except urllib.error.HTTPError as e:  # e.g. 422 for a symbol the contracts API does not know
        print("volume_error", und, date, e.code, flush=True)
        return 0


def _hist_volume(und, date, spot):
    lo = (dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat()
    hi = (dt.date.fromisoformat(date) + dt.timedelta(days=10)).isoformat()
    exp = next(iter(expiries(und, lo, hi)), None)
    if not exp: return 0
    syms = [occ(und, exp, k, r) for r in "CP" for k in chain(und, exp, r) if abs(k / spot - 1) <= 0.10]
    v = 0
    for i in range(0, len(syms), 100):
        q = dict(symbols=",".join(syms[i:i + 100]), timeframe="1Day", start=date, end=date, limit=10000)
        for s, b in (_get("https://data.alpaca.markets/v1beta1/options/bars?" + urllib.parse.urlencode(q)).get("bars") or {}).items():
            v += sum(x["v"] for x in b)
    return v


def spread_now(und, spot):
    today = dt.date.today()
    sp, n_contracts = [], 0
    token = None
    while True:
        q = dict(feed="opra", limit=1000, expiration_date_gte=(today + dt.timedelta(days=1)).isoformat(),
                 expiration_date_lte=(today + dt.timedelta(days=10)).isoformat())
        if token: q["page_token"] = token
        j = _get(f"https://data.alpaca.markets/v1beta1/options/snapshots/{und}?" + urllib.parse.urlencode(q))
        for sym, s in (j.get("snapshots") or {}).items():
            qt = s.get("latestQuote") or {}
            a, b = qt.get("ap"), qt.get("bp")
            if not a or not b or a <= b: continue
            mid = (a + b) / 2
            d = abs((s.get("greeks") or {}).get("delta") or 0)
            if not d:
                exp = "20" + sym[len(und):len(und) + 6]; exp = f"{exp[:4]}-{exp[4:6]}-{exp[6:8]}"
                T = max((dt.date.fromisoformat(exp) - today).days, 1) / 365
                d = delta(mid, spot, int(sym[-8:]) / 1000, T, 0.045, sym[len(und) + 6] == "C") or 0
            if 0.10 <= d <= 0.25:
                sp.append((a - b) / mid); n_contracts += 1
        token = j.get("next_page_token")
        if not token: break
    return (st.median(sp) if sp else None), n_contracts


def main():
    out = os.path.join(DATA, "liquidity.csv")
    now = {}
    for i in range(0, len(WIDE), 100):
        q = dict(symbols=",".join(WIDE[i:i + 100]), feed="sip")
        for s, x in _get("https://data.alpaca.markets/v2/stocks/snapshots?" + urllib.parse.urlencode(q)).items():
            if x and x.get("latestTrade"): now[s] = x["latestTrade"]["p"]
    rows, saved = {}, os.path.join(DATA, "liquidity_spread.csv")
    if os.path.exists(saved):  # spreads measured earlier today
        for r in csv.DictReader(open(saved)):
            rows[r["sym"]] = dict(sym=r["sym"], his=int(r["sym"] in P["universe"]), spread_now=r["spread_now"], quotes=r["quotes"])
    for und in WIDE:  # live spreads first: they are only available while the market is open
        if und in rows: continue
        sp, nc = spread_now(und, now[und]) if und in now else (None, 0)
        rows[und] = dict(sym=und, his=int(und in P["universe"]), spread_now=round(sp, 4) if sp is not None else "", quotes=nc)
        print("spread", und, rows[und]["spread_now"], nc, flush=True)
    closes = {d: stock_close(WIDE, d) for d in DATES}
    for und in WIDE:
        vols = [hist_volume(und, d, closes[d][und]) for d in DATES if und in closes[d]]
        rows[und]["vol_2024_01"] = round(st.fmean(vols)) if vols else 0
        print("volume", und, rows[und]["vol_2024_01"], flush=True)
    with open(out, "w") as f:
        w = csv.DictWriter(f, fieldnames=["sym", "his", "spread_now", "quotes", "vol_2024_01"]); w.writeheader(); w.writerows(rows.values())


if __name__ == "__main__":
    main()
