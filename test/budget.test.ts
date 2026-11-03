// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS as S, MIN, HOUR, freshGroupState, status, startSession, endSession, remainingMs, sessionsLeft, lengthOptions, canBorrow,
} from "../src/core.ts";

const x = S.groups.find((g) => g.id === "x")!;
const T0 = new Date(2026, 9, 28, 10, 0).getTime();

test("less than a minute left counts as done for the day", () => {
  const g = freshGroupState();
  // Three sessions, the last one ended 20 s early. The cooldown is long over.
  startSession(x, g, T0, 15); endSession(x, g, T0 + 15 * MIN);
  startSession(x, g, T0 + 1 * HOUR, 15); endSession(x, g, T0 + 1 * HOUR + 15 * MIN);
  startSession(x, g, T0 + 2 * HOUR, 15); endSession(x, g, T0 + 2 * HOUR + 15 * MIN - 20_000);
  const now = T0 + 3 * HOUR;
  assert.equal(remainingMs(x, g, now), 0);
  assert.equal(status(x, g, now), "exhausted");
  assert.equal(sessionsLeft(x, g, now), 0);
  assert.deepEqual(lengthOptions(x, g, now), []);
  assert.equal(startSession(x, g, now, 15), false);
  assert.ok(canBorrow(x, g, now), "borrowing still works from the done-for-today screen");
});

test("a full minute left is still one short session", () => {
  const g = freshGroupState();
  g.usedMs = 44 * MIN;
  assert.equal(status(x, g, T0), "ready");
  assert.deepEqual(lengthOptions(x, g, T0), [1]);
  assert.ok(startSession(x, g, T0, 1));
  assert.equal(g.session!.end - g.session!.start, MIN);
});

test("a session needs a real length", () => {
  const g = freshGroupState();
  for (const bad of [undefined, NaN, 0, -5]) assert.equal(startSession(x, g, T0, bad as number), false, `minutes=${bad}`);
  assert.equal(g.session, null);
  assert.equal(g.sessions, 0);
});
