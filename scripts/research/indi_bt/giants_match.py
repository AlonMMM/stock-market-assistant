"""Indi's big winners the bot catches, and the bot's big winners Indi did not have (the user, 2026-10-30: "show me how
many big winners we catch from indi and how many we added"), for each version of peer_rank.py.

His trades: his_tvd.csv (his main account, first buy, his return on all the premium he paid). A big winner: his return
>= 3x (giant) or >= 1x; the bot's: >= +300% at 2% returns ($30K on $10K). Same stock, date and side = the same trade.
Only his trades on the list's stocks in the list's period count (fair: HIS40 in PRIOR[year], Feb 2024 on; Favorites:
favorites.txt from A24), up to the last day of the bot's trades.

  python3 giants_match.py      (from the app repo root, after peer_rank.py)
"""
import collections, csv, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fav_real as FR
from low_delta import HIS40, PRIOR
from split import half

B = "data/local/x/bt"
T = json.load(open(f"{B}/peer_rank_trades.json"))
H = [r for r in csv.DictReader(open(f"{B}/his_tvd.csv"))]
LAST = max(t["date"] for t in T)
VERS = ["champion", "d2-20", "d2-15", "top2", "top1", "top2-d2-20", "top2-d2-15", "top1-d2-20", "top1-d2-15"]


def his(src):
    if src == "fair": return [h for h in H if "2024-02-01" <= h["date"] <= LAST and h["sym"] in HIS40 and h["sym"] in PRIOR[h["date"][:4]]]
    return [h for h in H if FR.A24 <= h["date"] <= LAST and h["sym"] in FR.FAV]


for src in ("fair", "fav"):
    print(f"\n#### {src}: his big winners caught, the bot's giants added (tune / check)\n")
    print("| Version | Bot trades | Bot giants | His giants (3x+) | caught (traded / also our giant) | His 1x+ winners | caught (traded / our giant) | Our giants he also traded | Our giants added (he wasn't there) |")
    print("|---|---|---|---|---|---|---|---|---|")
    Hs = his(src)
    hk = {(h["date"], h["sym"], h["right"]): float(h["ret"]) for h in Hs}
    for v in VERS:
        cells = collections.defaultdict(list)
        for part in ("tune", "check"):
            bot = {(t["date"], t["sym"], t["right"]): t["r2"] for t in T if t["src"] == src and t["half"] == part and v in t["keep"]}
            bg = {k for k, r in bot.items() if r >= 3}
            g3 = [k for k, r in hk.items() if r >= 3 and half(k[0]) == part]
            g1 = [k for k, r in hk.items() if r >= 1 and half(k[0]) == part]
            cells["n"].append(len(bot)); cells["bg"].append(len(bg))
            cells["g3"].append(f"{len(g3)}"); cells["c3"].append(f"{sum(k in bot for k in g3)} / {sum(k in bg for k in g3)}")
            cells["g1"].append(f"{len(g1)}"); cells["c1"].append(f"{sum(k in bot for k in g1)} / {sum(k in bg for k in g1)}")
            cells["with"].append(sum(k in hk for k in bg)); cells["add"].append(sum(k not in hk for k in bg))
        j = lambda k: " ; ".join(str(x) for x in cells[k])
        print(f"| {v} | {j('n')} | {j('bg')} | {j('g3')} | {j('c3')} | {j('g1')} | {j('c1')} | {j('with')} | {j('add')} |")
    print(f"\nHis trades on the list in the period: {len(Hs)}; the giants by name (tune+check):")
    print(", ".join(f"{k[1]} {k[0]} {k[2]} {r:.0f}x" for k, r in sorted(hk.items()) if r >= 3))
