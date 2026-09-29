# technical-scan (vendored)

`analyze.py` is the user's `technical-scan` skill script from
[AlonMMM/stock-scanner](https://github.com/AlonMMM/stock-scanner)
(`.claude/skills/technical-scan/scripts/analyze.py`, commit `4740df0`). The
skill's `SKILL.md` there remains the reference for what each number means.

One local change: `--options` is optional. Without it the options magnets
(call wall, put wall, max pain) and chart 04 are omitted, `summary.options` is
`null`, and the level ladder has no option levels. With the same options file,
the output matches the original on the skill's NVDA 2026-09-19 worked example
(checked 2026-09-29: identical `summary.json` apart from `generated_at`).

The collector feeds it Alpaca bars instead of IBKR `get_price_history` output;
see `packages/analysis/src/technical.ts`. When updating from stock-scanner,
re-apply the `--options` change and repeat the comparison.
