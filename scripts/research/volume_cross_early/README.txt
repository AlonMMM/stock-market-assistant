Volume bot: a slower plan cross (30 / 60 s) and an early shock buy (2026-11-06). Log: docs/research/volume-bot.md.
Run inside an app checkout of origin/main 62334b8 with engine.patch applied (adds the research-only SHOCK_EARLY switch;
not live): copy year.ts / crosslab.ts / crossdiag.ts into its scripts/ as .addyear.ts / .crosslab.ts / .crossdiag.ts
(memofetch.ts from ../volume_add_half as .memofetch.ts), then per version
  node --env-file=<main>/.env --import tsx scripts/.addyear.ts <d1.sqlite> <settings.json> <dir>/<version> "" 3
  (P30 / P60: settings with crossMaxSeconds 30 / 60; E50-30 / E50-20 / E30-30: SHOCK_EARLY=10,0.5,30 / 10,0.5,20 / 10,0.3,30)
  node --import tsx scripts/.crosslab.ts <dir> base P30 P60 E50-30 E50-20 E30-30
d1.sqlite: the read-only snapshot of ../volume_add_half, with stock_seconds re-dumped after the 2026-11-06 full-tape refill.
