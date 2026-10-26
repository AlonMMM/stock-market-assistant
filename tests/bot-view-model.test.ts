import { test } from "node:test";
import assert from "node:assert/strict";
import type { BotView } from "../packages/trading/src/bot-api.js";
import { withEntries } from "../apps/web/src/bot-view-model.js";

// Synthetic: 2026-10-26's shape, CRWV bought at Alpaca with "error" on its signal.
test("bot view: a signal with a position counts as bought", () => {
  const view = {
    signals: [
      { day: "2026-10-26", symbol: "CRWV", outcome: "error" },
      { day: "2026-10-26", symbol: "LITE", outcome: "thin" },
      { day: "2026-10-26", symbol: "NVDA", outcome: "refused" },
    ],
    positions: [
      { day: "2026-10-26", symbol: "CRWV", dry: false },
      { day: "2026-10-26", symbol: "NVDA", dry: true },
      { day: "2026-10-23", symbol: "LITE", dry: false },
    ],
  } as unknown as BotView;
  assert.deepEqual(
    withEntries(view).signals.map((s) => [s.symbol, s.outcome]),
    [
      ["CRWV", "bought"],
      ["LITE", "thin"],
      ["NVDA", "would-buy"],
    ],
  );
});
