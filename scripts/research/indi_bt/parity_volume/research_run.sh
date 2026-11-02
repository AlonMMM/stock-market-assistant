#!/bin/zsh
# The research simulator after the alignment (research/indi-v2 with the live leg, the 300-s prefilter, alerts by second):
# the new lists v54 / v54w / e_shock15v54 (54 live stocks, 2026-07-31..2026-10-30); the data it did not buy from where the
# app reads it (SEC_STOCK_DB: the app's D1 copy after its run; SEC_BOOKS_DB: the alert books backfill). 3%, flat3 + live3.
cd /Users/alonmo/Desktop/Personal/stock-market-assistant
V=${PARITY_DIR:?set PARITY_DIR to the run folder}
R=/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt/run.mjs
rm -rf $V/research_dump; mkdir -p $V/research_dump
L=${PARITY_LIST:-v54}   # the lists (leg_seconds.py list with SEC_TO, and the shock list) built for this period
env SEC_FROM=${PARITY_FROM:?} STR_TO=${PARITY_TO:?} SEC_TAG=$L SEC_ADD_TAG=${L}w,e_shock15$L STR_SHOCK_TAG=e_shock15$L \
  SEC_STOCK_DB=$V/d1.sqlite SEC_BOOKS_DB=/Users/alonmo/Desktop/Personal/stock-market-assistant/data/local/alert-books.sqlite \
  STR_CROSS_MAX=15 STR_NOSTOP_MIN=30 STR_AM_MIN=1.1 STR_AM_MIN_W=2.5 STR_PER_STOCK=2 \
  STR_FILTERS=shockbs STR_SRC_ENTRY=e_shock15$L=hold5:300 STR_SRC_DTE=e_shock15$L=2 STR_SRC_V=e_shock15$L=step35 \
  STR_ACCOUNTS=flat3,live3 STR_MAX_TRADES=15 STR_MAX_OPEN=5 STR_WALK_KEEP=1 STR_CHASE_NOFILL=ask \
  STR_DUMP_DIR=$V/research_dump \
  node --env-file=.env $R leg_seconds.py run > $V/research_run.txt 2>&1 < /dev/null
