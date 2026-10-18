// SYNTHETIC contract and prices.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankTicket,
  onOptionTick,
  stepOptionPrice,
  ticketBody,
  ticketLine,
} from "../apps/web/src/option-ticket-model.js";

const c = "NVDA261023C00190000";

test("option ticket: the usual stepped buy sends no order type", () => {
  assert.deepEqual(ticketBody(c, blankTicket(1.04)), {
    body: { contract: c, qty: 1, stopPct: 40 },
  });
});

test("option ticket: each type sends the prices it needs", () => {
  const f = { ...blankTicket(1.04), ladder: false };
  assert.deepEqual(ticketBody(c, f), {
    body: {
      contract: c,
      qty: 1,
      stopPct: 40,
      orderType: "limit",
      timeInForce: "day",
      limitPrice: 1.04,
    },
  });
  assert.deepEqual(
    ticketBody(c, {
      ...f,
      type: "stop_limit",
      stop: "1.10",
      limit: "1.15",
      tif: "gtc",
      autoStop: false,
      unit: "pct",
      size: "0.5",
    }),
    {
      body: {
        contract: c,
        sizePct: 0.5,
        autoStop: false,
        orderType: "stop_limit",
        timeInForce: "gtc",
        limitPrice: 1.15,
        stopPrice: 1.1,
      },
    },
  );
  const market = ticketBody(c, { ...f, type: "market", limit: "" });
  assert.ok("body" in market && !("limitPrice" in market.body));
  assert.deepEqual(ticketBody(c, { ...f, type: "stop", stop: "" }), {
    problem: "Stop price: whole cents below $3, 5 cents from $3.",
  });
  assert.deepEqual(ticketBody(c, { ...f, limit: "3.12" }), {
    problem: "Limit price: whole cents below $3, 5 cents from $3.",
  });
  assert.deepEqual(ticketBody(c, { ...f, size: "1.5" }), {
    problem: "Whole contracts only.",
  });
});

test("option ticket: prices keep to the tick; the line says what it does", () => {
  assert.equal(onOptionTick(1.234), 1.23);
  assert.equal(onOptionTick(3.12), 3.1);
  assert.equal(stepOptionPrice(2.99, true), 3);
  assert.equal(stepOptionPrice(3, true), 3.05);
  assert.equal(stepOptionPrice(3, false), 2.99);
  assert.equal(stepOptionPrice(0.01, false), 0.01);
  const f = { ...blankTicket(1), ladder: false };
  assert.match(
    ticketLine({ ...f, type: "stop", stop: "1.20", tif: "gtc" }, 1.04),
    /once the ask reaches 1.20.*Good till canceled.*gets its stop/,
  );
  assert.match(
    ticketLine({ ...f, autoStop: false }, 1.04),
    /No stop is placed/,
  );
});
