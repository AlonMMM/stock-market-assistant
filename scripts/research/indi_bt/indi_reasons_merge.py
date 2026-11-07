import json, collections, csv, re, sys, statistics as st
S = sys.argv[1]
A = {r["id"]: r for i in range(1, 9) for r in json.load(open(f"{S}/reasons/out/batch{i}.json"))}
E = {r["id"]: r for i in range(1, 5) for r in json.load(open(f"{S}/reasons/out2/eve{i}.json"))}
recs = json.load(open(f"{S}/choice/recs.json"))
mv = {}
for n, c in recs:
    for x in c:
        if x["sym"] == n["sym"]: mv[(n["sym"], n["date"], n["right"])] = x
GROUP = {
 "holds / refuses to fall vs market or its driver": {"held_vs_market_drop","strength_vs_spy","other:refuses_to_fall","other:stock_holds","other:gap_hold"},
 "the close (at the high, healthy, weak)": {"closed_at_high","other:weak_close"},
 "level / breakout": {"level_break","breakout_multi_day","failed_break_short"},
 "trend / day 2 / not finished": {"trend_continuation","day2_run","planned_swing"},
 "news / earnings / event": {"news","earnings_related","macro_event","other:short_interest"},
 "unusual volume / flow": {"volume_late","options_flow","other:huge_volume","other:unexplained_move"},
 "cheap option / low IV": {"cheap_option_iv"},
 "bitcoin / commodity / macro bet": {"crypto_bitcoin","commodity","market_direction_bet"},
 "sector / peer": {"sector_theme","peer_move"},
 "his usual name": {"known_name_repeat","big_name_liquid"},
 "gut": {"gut_conviction"},
 "stuck / hedge / roll / averaging": {"stuck_daytrade","hedge","averaging_down","other:roll_profit","other:roll","other:roll_up","other:spread_leg","other:straddle"},
}
rows = []
for k, a in A.items():
    e = E.get(k, {})
    eve_ok = e.get("found") and not e.get("uses_after_hours")
    tags = set(a["saw"]) | (set(e.get("saw", [])) if eve_ok else set())
    tags.discard("none")
    groups = [g for g, s in GROUP.items() if tags & s]
    m = re.match(r"(\d{4}-\d{2}-\d{2})-([A-Z.]+)-.*?([CPS])$", k)
    d, sym, side = (m.group(1), m.group(2), m.group(3)) if m else (None, None, None)
    x = mv.get((sym, d, side)) if side in "CP" else None
    rows.append(dict(id=k, date=d, sym=sym, side=side, evidence_before_close=a["evidence"], planned=a["planned_overnight"],
        why_before_close=a["why"], why_evening=e.get("why", "") if eve_ok else "", groups="; ".join(groups), tags=", ".join(sorted(tags)),
        others=", ".join(a.get("others") or []), expect=a.get("expect") or e.get("expect", ""), plan=a.get("plan") or e.get("plan", ""),
        market=a.get("market", ""), quote_he=a.get("quote_he") or e.get("quote_he", ""), quote_en=a.get("quote_en") or e.get("quote_en", ""),
        next_day=a.get("after", ""), atr_pct=round(x["atr_pct"], 2) if x and x.get("atr_pct") else "",
        move_his_way_pct=round(100 * x["on"], 2) if x and x.get("on") is not None else ""))
with open(f"{S}/reasons/indi_night_reasons_v2.csv", "w") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
json.dump(rows, open(f"{S}/reasons/indi_night_reasons_v2.json", "w"), ensure_ascii=False, indent=0)
real = [r for r in rows if r["planned"] != "no" and "stuck / hedge / roll / averaging" not in r["groups"]]
has = [r for r in real if r["groups"]]
print(len(rows), "trades;", len(real), "real night picks (not closed same day, not stuck/hedge/roll);", len(has), "with a stated reason (before close or evening)")
print("\nreason group: share of real picks with a reason | with stock data: n, 2%+ his way, 2%+ against, calm share")
cnt = collections.Counter(g for r in has for g in r["groups"].split("; "))
for g, n in cnt.most_common():
    x = [r for r in has if g in r["groups"] and r["move_his_way_pct"] != ""]
    if x:
        u = sum(r["move_his_way_pct"] >= 2 for r in x); dn = sum(r["move_his_way_pct"] <= -2 for r in x)
        calm = sum(r["atr_pct"] != "" and r["atr_pct"] < 3.6 for r in x)
        extra = f"| n{len(x):3d}  up2 {100*u/len(x):3.0f}%  down2 {100*dn/len(x):3.0f}%  calm {100*calm/len(x):3.0f}%"
    else: extra = ""
    print(f"{g:50s} {n:4d} ({100*n/len(has):3.0f}%) {extra}")
x = [r for r in real if not r["groups"] and r["move_his_way_pct"] != ""]
if x: print(f"{'no reason stated':50s} {len(real)-len(has):4d}        | n{len(x):3d}  up2 {100*sum(r['move_his_way_pct']>=2 for r in x)/len(x):3.0f}%  down2 {100*sum(r['move_his_way_pct']<=-2 for r in x)/len(x):3.0f}%")
