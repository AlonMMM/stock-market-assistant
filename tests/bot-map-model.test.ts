import assert from "node:assert/strict";
import test from "node:test";
import {
  mapTicks,
  panDomain,
  zoomDomain,
} from "../apps/web/src/bot-map-model.js";

const full = { x0: 0, x1: 6, y0: -6, y1: 6 };

test("map zoom: in around a point, which stays put", () => {
  const z = zoomDomain(full, full, 2, 3, 0)!;
  assert.deepEqual(z, { x0: 1.5, x1: 4.5, y0: -3, y1: 3 });
  // Around a corner: the view slides back inside the map.
  const c = zoomDomain(full, full, 2, 6, 6)!;
  assert.deepEqual(c, { x0: 3, x1: 6, y0: 0, y1: 6 });
});

test("map zoom: out to the whole map ends the zoom; at most 20×", () => {
  const z = zoomDomain(full, full, 2, 3, 0)!;
  assert.equal(zoomDomain(z, full, 0.4, 3, 0), null);
  const deep = zoomDomain(full, full, 1000, 3, 0)!;
  assert.ok(Math.abs(deep.x1 - deep.x0 - 0.3) < 1e-9);
});

test("map zoom: a drag moves the view, not past the edge", () => {
  const z = zoomDomain(full, full, 2, 3, 0)!;
  assert.deepEqual(panDomain(z, full, 1, -1), {
    x0: 2.5,
    x1: 5.5,
    y0: -4,
    y1: 2,
  });
  assert.deepEqual(panDomain(z, full, 10, 0), {
    x0: 3,
    x1: 6,
    y0: -3,
    y1: 3,
  });
});

test("map ticks: round steps in view, the threshold always among them", () => {
  assert.deepEqual(mapTicks(1, 3, 1.5), [1, 1.5, 2, 2.5, 3]);
  assert.deepEqual(mapTicks(0.8, 2.3, 1.2), [1, 1.2, 1.5, 2]);
  assert.deepEqual(mapTicks(-2, 2, 2.5, true), [-2, -1, 0, 1, 2]);
  assert.deepEqual(mapTicks(1, 4, 3, true), [1, 2, 3, 4]);
});
