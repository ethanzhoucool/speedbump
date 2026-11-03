// Run with: npm test
// Day boundaries in a zone with daylight saving time. node --test runs each file in its own process,
// so setting TZ here doesn't touch the other tests.
process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { MIN, dayKey, nextResetAt, shiftDay } from "../src/core.ts";

// 2026 in New York: clocks go forward on 8 March (02:00 -> 03:00) and back on 1 November (02:00 -> 01:00).
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const spans = [[local(2026, 3, 6, 0), local(2026, 3, 11, 0)], [local(2026, 10, 30, 0), local(2026, 11, 4, 0)]];

test("the day changes exactly at the next reset, including on DST days", () => {
  for (const resetHour of [0, 1, 2, 3, 4, 12, 23]) {
    for (const [from, to] of spans) {
      for (let t = from; t < to; t += 15 * MIN) {
        const r = nextResetAt(t, resetHour);
        const at = `resetHour=${resetHour} at ${new Date(t).toString()}`;
        assert.equal(dayKey(t, resetHour), dayKey(r - 1, resetHour), `no early change before the reset, ${at}`);
        assert.notEqual(dayKey(r, resetHour), dayKey(r - 1, resetHour), `changes at the reset, ${at}`);
      }
    }
  }
});

test("a 4am reset happens at 4am on the day clocks go forward and the day they go back", () => {
  assert.equal(dayKey(local(2026, 3, 8, 3, 59), 4), "2026-03-07");
  assert.equal(dayKey(local(2026, 3, 8, 4, 30), 4), "2026-03-08");
  assert.equal(dayKey(local(2026, 11, 1, 3, 30), 4), "2026-10-31");
  assert.equal(dayKey(local(2026, 11, 1, 4, 0), 4), "2026-11-01");
});

test("shiftDay walks the calendar, not 24 hour steps", () => {
  assert.equal(shiftDay("2026-11-02", -1), "2026-11-01");
  assert.equal(shiftDay("2026-11-01", -1), "2026-10-31");
  assert.equal(shiftDay("2026-03-09", -1), "2026-03-08");
  assert.equal(shiftDay("2026-11-01", -6), "2026-10-26");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDay("2028-02-28", 1), "2028-02-29");
  // The last 7 days on the evening clocks went back. Stepping back 24 h at a time lands on the same date twice.
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(dayKey(local(2026, 11, 1, 23, 30)), i - 6));
  assert.deepEqual(days, ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
});

test("the same holds all year in zones that change their clocks differently", () => {
  for (const zone of ["Europe/Berlin", "Australia/Sydney", "America/Santiago"]) {
    process.env.TZ = zone;
    for (const resetHour of [0, 2, 4]) {
      for (let t = local(2026, 1, 1, 0); t < local(2027, 1, 1, 0); t += 30 * MIN) {
        const r = nextResetAt(t, resetHour);
        assert.ok(r > t && r - t <= 26 * 60 * MIN, `${zone} resetHour=${resetHour} at ${new Date(t).toString()}`);
        assert.equal(dayKey(t, resetHour), dayKey(r - 1, resetHour), `${zone} resetHour=${resetHour} at ${new Date(t).toString()}`);
        assert.notEqual(dayKey(r, resetHour), dayKey(r - 1, resetHour), `${zone} resetHour=${resetHour} at ${new Date(t).toString()}`);
      }
    }
  }
  process.env.TZ = "America/New_York";
});
