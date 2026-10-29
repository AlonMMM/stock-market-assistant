import assert from "node:assert/strict";
import test from "node:test";
import {
  barAt,
  nextSession,
  overnightEnd,
  sessionAt,
} from "../packages/market-data/src/sessions.js";

// 2026-10-19 is a Monday; New York is UTC−4 in October.
const ny = (day: string, hhmm: string) =>
  Date.parse(`2026-10-${day}T${hhmm}:00-04:00`);
const s = (ms: number) => ms / 1000;

test("parts of a trading day, and who owns the overnight", () => {
  assert.deepEqual(sessionAt(ny("19", "04:00"))?.part, "pre");
  assert.deepEqual(sessionAt(ny("19", "09:30"))?.part, "regular");
  assert.deepEqual(sessionAt(ny("19", "16:00"))?.part, "post");
  // Monday 20:00 to Tuesday 04:00 is Monday's overnight.
  assert.deepEqual(sessionAt(ny("19", "20:00")), {
    date: "2026-10-19",
    part: "overnight",
    minute: 1200,
  });
  assert.equal(sessionAt(ny("20", "03:59"))?.date, "2026-10-19");
  assert.equal(sessionAt(ny("20", "03:59"))?.part, "overnight");
  // Sunday night leads into Monday: it belongs to Friday.
  assert.deepEqual(sessionAt(ny("18", "21:00"))?.date, "2026-10-16");
  assert.deepEqual(sessionAt(ny("19", "02:00"))?.date, "2026-10-16");
  // Friday night and Saturday trade nothing.
  assert.equal(sessionAt(ny("16", "21:00")), null);
  assert.equal(sessionAt(ny("17", "12:00")), null);
  assert.equal(sessionAt(ny("18", "03:00")), null);
});

test("bars line up on 09:30 and start at their part's boundary", () => {
  assert.equal(barAt(ny("19", "09:44"), 15)?.start, s(ny("19", "09:30")));
  assert.equal(barAt(ny("19", "10:45"), 60)?.start, s(ny("19", "10:30")));
  // Pre-market 1h: 04:00–04:30 is a short bar, then 04:30, 05:30, …
  assert.equal(barAt(ny("19", "04:10"), 60)?.start, s(ny("19", "04:00")));
  assert.equal(barAt(ny("19", "04:40"), 60)?.start, s(ny("19", "04:30")));
  // 16:00 on 1h bars: its own after-hours bar, apart from 15:30.
  const last = barAt(ny("19", "15:45"), 60)!;
  const after = barAt(ny("19", "16:05"), 60)!;
  assert.equal(after.start, s(ny("19", "16:00")));
  assert.notEqual(after.key, last.key);
  assert.ok(after.key > last.key);
  // Overnight bars count from 20:00 and order after after-hours.
  const night = barAt(ny("20", "01:07"), 5)!;
  assert.equal(night.date, "2026-10-19");
  assert.equal(night.start, s(ny("20", "01:05")));
  assert.ok(night.key > after.key);
  assert.equal(barAt(ny("19", "20:20"), 60)?.start, s(ny("19", "20:00")));
});

test("next session and the end of an overnight", () => {
  assert.equal(nextSession("2026-10-16"), "2026-10-19");
  assert.equal(overnightEnd("2026-10-16"), ny("19", "04:00"));
  assert.equal(overnightEnd("2026-10-19"), ny("20", "04:00"));
});
