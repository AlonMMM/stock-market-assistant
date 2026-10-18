// SYNTHETIC orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { outcome } from "../apps/web/src/order-run.js";

test("an option order left working, and a buy with no stop, read plainly", () => {
  const working = outcome(
    {
      state: "done",
      result: {
        result: { order: { qty: 2, filledQty: 0, filledAvgPrice: null } },
        working: true,
        noStop: true,
      },
    },
    true,
  );
  assert.deepEqual(working, {
    ok: true,
    lines: [
      "Nothing filled yet.",
      "2 still working at the broker. Change or cancel it from Orders.",
    ],
  });
  const bought = outcome(
    {
      state: "done",
      result: {
        result: { order: { qty: 2, filledQty: 2, filledAvgPrice: 1.05 } },
        noStop: true,
      },
    },
    true,
  );
  assert.deepEqual(bought.lines, ["Bought 2 at 1.05.", "No stop, as chosen."]);
});
