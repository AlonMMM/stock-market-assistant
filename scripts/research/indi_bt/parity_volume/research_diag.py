"""Per alert, what the research simulator (leg_seconds.py run, same env as research_run.sh) did with it, step by step,
using the simulator's own functions (read-only): the trigger, the cross time, the burst, the pick, the 1-second book file,
the buy book, the walk, the sale quote, the news skip. Writes research_alerts.json. Run from the main checkout root."""
import gzip, csv, json, os, sys
R = "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt"
sys.path.insert(0, R)
os.environ.setdefault("BT_VARIANT", "v2")
for k, v in dict(SEC_FROM=os.environ.get("PARITY_FROM", "2026-07-31"), SEC_TAG=os.environ.get("DIAG_TAGS", "3y50q").split(",")[0], STR_NOSTOP_MIN="30", STR_WALK_KEEP="1", STR_CHASE_NOFILL="ask").items():
    os.environ.setdefault(k, v)
import leg_seconds as LS
import leg_realspread as RS
import leg_fallback as LF
import news_filter as nf
from store import day

OUT = sys.argv[1]
LO, HI = os.environ.get("PARITY_FROM", "2026-07-31"), os.environ.get("PARITY_TO", "2026-10-30")
EX50 = set("SQQQ,SNDK,RDDT,PATH,IBM,ADBE,ARM,NOW,SHOP,VRT,TLT,APP,CVNA,AFRM,UPST,MARA,RIOT,RIVN,SNAP,PYPL,DKNG".split(","))
TAGS = os.environ.get("DIAG_TAGS", "3y50q,3y50wq,3ycandq,3ycandwq,3ycand5q,3ycand5wq,e_shock15").split(",")
SHOCK = os.environ.get("STR_SHOCK_TAG", "e_shock15")
SC = os.path.join(R, "sec_cache")
rows = []
for tag in TAGS:
    ev = json.load(open(os.path.join(SC, f"events{tag}.json")))
    pk = json.load(open(os.path.join(SC, f"picks{tag}.json")))
    for e, p in zip(ev, pk):
        if e["sym"] in EX50 or not (LO <= e["date"] <= HI): continue
        e = dict(e, src=tag)
        shock = tag == SHOCK
        a_sec = e["sec0"] if shock else (e["m"] + 1) * 60
        entry, ver = ("hold5", "step35") if shock else ("cross", "plain20")
        r = dict(date=e["date"], sym=e["sym"], kind="shock" if shock else "plan", tag=tag, alert_sec=a_sec, minute=e["m"],
                 expiry=e["nxt"], dte_kind=e["kind"], stock_file=LS.stock_rows(e) is not None)
        tg = p["t"].get(entry)
        r["trigger"] = tg
        if not tg:
            r["stage"] = "no_side_file" if not r["stock_file"] else "no_side"; rows.append(r); continue
        r["to_side"] = tg[0] - a_sec
        lim = 300 if shock else 15
        if r["to_side"] > lim: r["stage"] = "slow_cross"; rows.append(r); continue
        if shock:
            from datetime import date as _d
            if (_d.fromisoformat(e["nxt"]) - _d.fromisoformat(e["date"])).days > 2: r["stage"] = "dte>2"; rows.append(r); continue
        bx = {b[0]: b for b in day(e["sym"], e["date"])}
        sign = 1 if tg[1] == "C" else -1
        am = None
        if shock:
            k = (e["sec0"] - 180) // 60 - 1
            if k in bx: am = sign * (e["stock0"] / bx[k][4] - 1) / e["u"]
        elif e["m"] in bx and e["m"] - 3 in bx: am = sign * (bx[e["m"]][4] / bx[e["m"] - 3][4] - 1) / e["u"]
        r["am"] = am
        need = 0 if shock else (2.5 if e["kind"] == "w" else 1.1)
        if am is None or am < need: r["stage"] = "burst"; rows.append(r); continue
        x = p["p"].get(f"{entry}|{ver}")
        if not x: r["stage"] = "no_pick"; rows.append(r); continue
        r["contract"], r["pick_delta"] = x[0], x[1]
        book = LS.opt_rows(e, x[0], tg[0])
        r["opt_file"] = book is not None
        if book is None: r["stage"] = "missing_1s_book_file"; rows.append(r); continue
        book = [(int(a), b, c) for a, b, c in book]
        book = [b for b in book if float(b[1]) > 0 and float(b[2]) > 0]
        if not LS.book_at(book, tg[0] + LS.LAG): r["stage"] = "no_book_at_buy"; r["book_rows"] = len(book); rows.append(r); continue
        t = LS.trade((e, entry, ver, x[0], x[1], tg))
        if not t:
            w = LF.walk(e["sym"], e["date"], tg[0] // 60, tg[1], x[0], tg[2], e["u"])
            r["stage"] = "no_sale_quote" if w else "walk_none"
            if w: r["exit_minute"] = w[3]
            rows.append(r); continue
        r["stage"] = "trade"
        r["trade"] = {k: t[k] for k in ("buy", "sell", "ct", "xm", "side", "spread", "am", "to_cross", "stock_in", "contract")}
        if shock and (t["spread"] is None or t["spread"] > 0.3): r["stage"] = "wide_spread"
        rows.append(r)
feat = [dict(date=d, sym=s, minute=0, right="C") for d, s in {(r["date"], r["sym"]) for r in rows}]
nf.features(feat)
skip = {}
for f in feat:
    if f["e_next"] == 0: skip[(f["date"], f["sym"])] = "earnings"
    elif f["pre_rvol"] is not None and f["pre_rvol"] >= 4: skip[(f["date"], f["sym"])] = "premarket"
for r in rows:
    r["news"] = skip.get((r["date"], r["sym"]))
json.dump(rows, open(OUT, "w"))
import collections
print(len(rows), collections.Counter(r["stage"] for r in rows))
