# Volume bot: the app's backtest against the research, trade by trade

The stage-5 live check of the `bot-lifecycle` skill for the Volume bot (`bot-live-check`). First used 2026-11-01:
75 of 75 trades identical, Volume 1.0.0, 54 stocks, 2026-07-31 .. 2026-10-30. `research_run.sh` carries 1.0.0's rules
(the research defaults) and the owner's limits of that day; another version adds its research twin's switches from
`bots.md` (1.1.0: `PF_MAX_S=20` for the shock list, `STR_LIQ_OLD=1` on the run), and the limits follow the saved settings.

One run folder (`PARITY_DIR`, in the scratchpad) holds every file. From the app's main checkout root:

1. Settings, read-only: the trader's saved Volume settings (connector `volume_bot_settings`) -> `$PARITY_DIR/strangle_settings.json`.
2. D1 snapshot, only SELECTs: `PARITY_FROM=.. PARITY_TO=.. python3 d1_dump.py $PARITY_DIR/d1.sqlite`.
3. App engine (the deployed `main` in `APP_DIR`, default `~/Desktop/Personal/sma-deploy`):
   `VOLUME_SETTINGS=$PARITY_DIR/strangle_settings.json node --env-file=.env --import tsx <this dir>/app_run.mts $PARITY_DIR/d1.sqlite $PARITY_DIR/app_full.json <from> <to>`.
   It fills the snapshot with what it fetches; the research then reads the same 1-second stock prices from it.
4. Research lists for the period (`leg_seconds.py list` with `SEC_TO`, the shock list prefiltered), tag `PARITY_LIST`.
5. Research run: `PARITY_DIR=.. PARITY_FROM=.. PARITY_TO=.. PARITY_LIST=.. zsh research_run.sh`, and the per-alert
   trace `PARITY_FROM=.. PARITY_TO=.. DIAG_TAGS=<lists> node --env-file=.env <indi_bt>/run.mjs parity_volume/research_diag.py $PARITY_DIR/research_alerts.json`.
6. Compare: `PARITY_DIR=.. python3 compare.py <from> <to>` -> `volume_compare.json` (match per alert, both accounts).

Expect `same` on every alert; any other row is a bug on one side, found and fixed before the check passes.
