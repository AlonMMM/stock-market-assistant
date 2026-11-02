"""Trade by trade: the app engine (app_full.json) against the research simulator (research_dump + research_alerts.json).
  python3 compare.py <from> <to>   -> volume_compare.json"""
import collections, json, os, sys
V = os.environ.get("PARITY_DIR", os.getcwd())   # the run folder: app_full.json, research_dump/, research_alerts.json
LO, HI = sys.argv[1], sys.argv[2]
FEE = 0.62
APP = os.environ.get("APP_FILE", "app_full.json"); DUMP = os.environ.get("DUMP_DIR", "research_dump"); RA = os.environ.get("RA_FILE", "research_alerts.json"); SFX = os.environ.get("OUT_SFX", ""); SHOCK = os.environ.get("STR_SHOCK_TAG", "e_shock15")
app = json.load(open(f"{V}/{APP}"))
sigs = [s for r in app["runs"] for s in r["signals"] if LO <= s["date"] <= HI]
acct = {a["signal"]["id"]: a for a in app["account"]["trades"]}
ra = json.load(open(f"{V}/{RA}"))
live = json.load(open(f"{V}/{DUMP}/live3_shock_30_burst_0.json"))
flat = json.load(open(f"{V}/{DUMP}/flat3_shock_30_burst_0.json"))


def rkey(t): return (t["date"], t["sym"], "shock" if t["src"] == SHOCK else "plan", t["alert_sec"])


live_by = {rkey(t): t for t in live if LO <= t["date"] <= HI}
flat_by = {rkey(t): t for t in flat if LO <= t["date"] <= HI}
diag = {(r["date"], r["sym"], r["kind"], r["alert_sec"]): r for r in ra if LO <= r["date"] <= HI}
appk = {(s["date"], s["symbol"], s["kind"], s["second"]): s for s in sigs}
ret = lambda buy, sell: (sell * 100 - FEE) / (buy * 100 + FEE) - 1


def qty_of(t):
    d = (t["sell"] - t["buy"]) * 100 - 2 * FEE
    return round(t["pnl"] / d) if abs(d) > 1e-9 else None


def clock(sec):
    t = 34200 + sec
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}"


keys = set(live_by) | set(flat_by)
keys |= {k for k, s in appk.items() if s.get("trade")}
keys |= {k for k, r in diag.items() if r["stage"] == "trade" and not r["news"]}
rows = []
for k in sorted(keys):
    s, r, lt = appk.get(k), diag.get(k), live_by.get(k)
    a = acct.get(s["id"]) if s else None
    row = dict(date=k[0], symbol=k[1], kind=k[2], alert_second=k[3], alert_time_ny=clock(k[3]))
    # ---- app ----
    if s:
        t = s.get("trade")
        row["app"] = dict(outcome=s["outcome"], detail=s["detail"], burst=s["burst"], expiry=s["expiry"],
                          account=a["status"] if a else None)
        if t:
            row["app"].update(side="call" if t["right"] == "C" else "put", contract=t["contract"], delta=t["delta"], fallback=t["fallback"],
                              entry_second=t["sideSecond"], entry_time_ny=clock(t["sideSecond"]), entry_minute=t["buyMinute"],
                              buy=t["buy"], buy_priced=t["buyPriced"], book=t["book"], spread=t["spread"], exit_minute=t["exitMinute"],
                              exit_reason=t["exitReason"], sell=t["sell"], sell_priced=t["sellPriced"], return_pct=round(100 * ret(t["buy"], t["sell"]), 2))
            if a and a["status"] == "taken": row["app"].update(qty=a["qty"], pnl=round(a["pnl"], 2))
    else:
        row["app"] = dict(outcome="no_alert")
    # ---- research ----
    if r:
        row["research"] = dict(stage=r["stage"], news=r["news"], tag=r["tag"], to_side=r.get("to_side"), am=r.get("am"), contract=r.get("contract"))
        tt = r.get("trade")
        if tt:
            row["research"].update(side="call" if tt["side"] == "C" else "put", entry_second=r["trigger"][0], entry_time_ny=clock(r["trigger"][0]),
                                   entry_minute=tt["ct"], buy=tt["buy"], exit_minute=tt["xm"], exit_reason="end" if tt["xm"] >= 360 else "giveback",
                                   sell=tt["sell"], spread=tt["spread"], return_pct=round(100 * ret(tt["buy"], tt["sell"]), 2))
        if r["stage"] == "no_sale_quote": row["research"]["exit_minute"] = r.get("exit_minute")
        acc = "taken" if lt else ("refused_by_live_limits" if k in flat_by else ("not_kept" if r["stage"] == "trade" else None))
        row["research"]["account"] = acc
        if lt: row["research"].update(qty=qty_of(lt), pnl=round(lt["pnl"], 2))
    else:
        row["research"] = dict(stage="no_alert")
    # ---- match ----
    at = row["app"].get("account") == "taken"
    rt = row["research"].get("account") == "taken"
    if at and rt:
        A, B = row["app"], row["research"]
        same = A["contract"] == B["contract"] and A["entry_minute"] == B["entry_minute"] and A["exit_minute"] == B["exit_minute"]
        if same and abs(A["buy"] - B["buy"]) < 1e-6 and abs(A["sell"] - B["sell"]) < 1e-6: row["match"] = "same"
        elif same: row["match"] = "price-diff"; row["diff"] = dict(buy=round(A["buy"] - B["buy"], 4), sell=round(A["sell"] - B["sell"], 4), pnl=round(A["pnl"] - B["pnl"], 2))
        else: row["match"] = "trade-diff"
    elif at: row["match"] = "app-only"
    elif rt: row["match"] = "research-only"
    else: row["match"] = "neither-taken"
    rows.append(row)


def summary(taken):
    return dict(trades=len(taken), wins=sum(p > 0 for p in taken))


app_taken = [a for a in app["account"]["trades"] if a["status"] == "taken" and LO <= a["signal"]["date"] <= HI]
out = dict(period=[LO, HI], counts=collections.Counter(r["match"] for r in rows), rows=rows)
json.dump(out, open(f"{V}/volume_compare{SFX}_{LO}_{HI}.json", "w"), indent=1, default=str)
print(LO, HI, dict(out["counts"]), "app taken", len(app_taken), "research taken", len(live_by))
