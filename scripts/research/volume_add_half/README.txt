Volume bot: add half on a same-direction alert while the open leg is up (2026-11-06). Log: docs/research/volume-bot.md.
These run inside an app checkout of origin/main (63b0321): copy addyear.ts / addlab.ts / memofetch.ts into its scripts/
(as .addyear.ts, .addlab.ts, .memofetch.ts; the imports are relative to scripts/), then
  node --env-file=<main>/.env --import tsx scripts/.addyear.ts <d1.sqlite> <settings.json> <outDir> "" 4   (~1 h)
  node --import tsx scripts/.addlab.ts <d1.sqlite> <outDir>
d1.sqlite: a read-only snapshot of production D1 sma-bars-cache (volume_alerts, stock_seconds, option_seconds,
option_quotes, option_bars; 2025-10-01 .. 2026-10-30), dumped 2026-11-06 with d1_dump_resume.py (SELECTs only).
settings.json: the live Volume 1.3.0 saved settings. addlab_output.txt: the run's output.
