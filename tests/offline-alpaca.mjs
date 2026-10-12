// Preloaded into the collector by tests: every Alpaca request fails, as in an
// outage, while other requests go through.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  String(input instanceof Request ? input.url : input).includes(
    "alpaca.markets",
  )
    ? Promise.reject(new TypeError("fetch failed"))
    : realFetch(input, init);
