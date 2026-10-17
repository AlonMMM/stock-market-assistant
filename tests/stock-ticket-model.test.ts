// SYNTHETIC symbol and prices.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankForm,
  changeBody,
  describeOrder,
  ticketBody,
  withType,
  type OpenStockOrder,
} from "../apps/web/src/stock-ticket-model.js";
import { allowedTimeInForce } from "../packages/trading/src/stock-tickets.js";
import { allowedTimeInForce as offered } from "../apps/web/src/stock-ticket-model.js";

test("stock ticket: the page offers the service's times in force", () => {
  assert.deepEqual(offered, allowedTimeInForce);
});

test("stock ticket: each type sends the fields it needs", () => {
  const f = { ...blankForm, size: "10" };
  assert.deepEqual(ticketBody("AAPL", { ...f, type: "market" }), {
    body: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      timeInForce: "day",
      qty: 10,
    },
  });
  assert.deepEqual(ticketBody("AAPL", { ...f, type: "limit", limit: "" }), {
    problem: "Enter a limit price.",
  });
  assert.deepEqual(
    ticketBody("AAPL", {
      ...f,
      side: "sell",
      size: "all",
      type: "stop_limit",
      tif: "gtc",
      stop: "95",
      limit: "94.5",
    }),
    {
      body: {
        symbol: "AAPL",
        side: "sell",
        type: "stop_limit",
        timeInForce: "gtc",
        qty: "all",
        limitPrice: 94.5,
        stopPrice: 95,
      },
    },
  );
  const trail = ticketBody("AAPL", {
    ...f,
    side: "sell",
    type: "trailing_stop",
    trailBy: "price",
    trail: "1.5",
  });
  assert.equal("body" in trail && trail.body.trailPrice, 1.5);
  assert.equal("body" in trail && "trailPercent" in trail.body, false);
  // Dollars for a buy; extended hours only where allowed.
  assert.deepEqual(
    ticketBody("AAPL", {
      ...f,
      unit: "usd",
      size: "2500",
      limit: "100",
      extended: true,
    }),
    {
      body: {
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        timeInForce: "day",
        amount: 2500,
        limitPrice: 100,
        extendedHours: true,
      },
    },
  );
  const ioc = ticketBody("AAPL", {
    ...f,
    limit: "100",
    tif: "ioc",
    extended: true,
  });
  assert.equal("body" in ioc && "extendedHours" in ioc.body, false);
  assert.deepEqual(ticketBody("AAPL", { ...f, size: "1.5", type: "market" }), {
    problem: "Whole shares only.",
  });
  // The stepped order keeps its own body.
  assert.deepEqual(ticketBody("AAPL", { ...f, type: "auto" }), {
    body: { symbol: "AAPL", qty: 10 },
  });
});

test("stock ticket: a type that does not take the time in force resets it", () => {
  const f = withType({ ...blankForm, tif: "ioc", extended: true }, "stop");
  assert.equal(f.tif, "day");
  assert.equal(f.extended, false);
  assert.equal(
    withType({ ...blankForm, tif: "gtc" }, "trailing_stop").tif,
    "gtc",
  );
});

test("stock ticket: open orders read plainly and change only what moved", () => {
  const o: OpenStockOrder = {
    orderId: "o1",
    side: "sell",
    type: "stop_limit",
    timeInForce: "gtc",
    qty: 10,
    filledQty: 2,
    price: 94.5,
    limitPrice: 94.5,
    stopPrice: 95,
  };
  assert.equal(
    describeOrder(o),
    "Sell 8 (2 filled) · Stop limit · stop 95.00 · limit 94.50 · GTC",
  );
  const same = { qty: "10", limit: "94.50", stop: "95.00", trail: "" };
  assert.equal(changeBody(o, same), null);
  assert.deepEqual(changeBody(o, { ...same, stop: "96" }), {
    body: { orderId: "o1", stopPrice: 96 },
  });
  assert.deepEqual(changeBody(o, { ...same, qty: "x" }), {
    problem: "Whole shares only.",
  });
  const trailing: OpenStockOrder = {
    orderId: "o2",
    side: "sell",
    type: "trailing_stop",
    qty: 5,
    filledQty: 0,
    price: null,
    limitPrice: null,
    // Alpaca reports where the trailing stop is now; it is not changed.
    stopPrice: 101.2,
    trailPercent: 4,
  };
  assert.deepEqual(
    changeBody(trailing, { qty: "5", limit: "", stop: "", trail: "3" }),
    { body: { orderId: "o2", trail: 3 } },
  );
});
