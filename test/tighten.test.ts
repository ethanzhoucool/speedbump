// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS as S, MIN, freshGroupState, startSession, endSession, borrow, clampSession, usedMs } from "../src/core.ts";

const x = S.groups.find((g) => g.id === "x")!;
const T0 = new Date(2026, 9, 28, 10, 0).getTime();

test("a shorter session length applies to the session already running", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  assert.ok(clampSession({ ...x, sessionMin: 10 }, g, T0 + 5 * MIN));
  assert.equal(g.session!.end, T0 + 10 * MIN);
});

test("if the new length has already passed, the session ends now and keeps the time spent", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  const now = T0 + 12 * MIN;
  assert.ok(clampSession({ ...x, sessionMin: 10 }, g, now));
  assert.equal(g.session!.end, now);
  endSession(x, g, now);
  assert.equal(g.usedMs, 12 * MIN);
});

test("a smaller daily budget cuts the running session to what's left", () => {
  const g = freshGroupState();
  g.usedMs = 30 * MIN;
  startSession(x, g, T0, 15);
  assert.ok(clampSession({ ...x, dailyMin: 35 }, g, T0 + 2 * MIN));
  assert.equal(g.session!.end, T0 + 5 * MIN);
  assert.equal(usedMs(g, T0 + 5 * MIN), 35 * MIN);
});

test("looser or unchanged rules leave the session alone", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  assert.equal(clampSession(x, g, T0 + MIN), false);
  assert.equal(clampSession({ ...x, sessionMin: 30, dailyMin: 90 }, g, T0 + MIN), false);
  assert.equal(g.session!.end, T0 + 15 * MIN);
  assert.equal(clampSession(x, freshGroupState(), T0), false, "no session");
});

test("a borrowed session keeps its 10 minutes under a short session length", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  endSession(x, g, T0 + 15 * MIN);
  const t = T0 + 20 * MIN;
  borrow(x, g, t);
  assert.equal(clampSession({ ...x, sessionMin: 5 }, g, t + MIN), false);
  assert.equal(g.session!.end, t + 10 * MIN);
});
