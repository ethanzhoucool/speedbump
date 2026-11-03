// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS as S, MIN, HOUR, freshGroupState, startSession, settle, status, remainingMs } from "../src/core.ts";

const x = S.groups.find((g) => g.id === "x")!;
const T0 = new Date(2026, 9, 28, 10, 0).getTime();
const GRACE = S.idleGraceMin * MIN;

test("a session left behind while the laptop slept ends when it was last seen", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  g.session!.lastSeen = T0 + 2 * MIN; // last tick before the lid closed
  const wake = T0 + HOUR;
  assert.equal(settle(x, g, wake, GRACE), "abandoned");
  assert.equal(g.session, null);
  assert.equal(g.usedMs, 2 * MIN, "only the time actually there is charged");
  assert.equal(g.fullSessions, 0, "and it doesn't lengthen the next pause");
  assert.equal(g.cooldownFrom, T0 + 2 * MIN);
  assert.equal(status(x, g, wake), "ready");
  assert.equal(remainingMs(x, g, wake), 43 * MIN);
});

test("a session watched to the end still counts in full", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  g.session!.lastSeen = T0 + 14.5 * MIN;
  assert.equal(settle(x, g, T0 + 15 * MIN + 500, GRACE), "expired");
  assert.equal(g.usedMs, 15 * MIN);
  assert.equal(g.fullSessions, 1);
  assert.equal(g.cooldownFrom, T0 + 15 * MIN);
});

test("an expired session settled late is charged to its end, not to now", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  g.session!.lastSeen = T0 + 14 * MIN;
  assert.equal(settle(x, g, T0 + 3 * HOUR, GRACE), "expired");
  assert.equal(g.usedMs, 15 * MIN);
});

test("a running session that was just seen is left alone", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  g.session!.lastSeen = T0 + 5 * MIN;
  assert.equal(settle(x, g, T0 + 6 * MIN, GRACE), null);
  assert.ok(g.session);
  assert.equal(settle(x, freshGroupState(), T0, GRACE), null, "no session, nothing to do");
});

test("away from the site for longer than the grace period ends it early, as before", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  g.session!.lastSeen = T0 + 3 * MIN;
  assert.equal(settle(x, g, T0 + 3 * MIN + GRACE, GRACE), null, "exactly the grace period is still fine");
  assert.equal(settle(x, g, T0 + 3 * MIN + GRACE + 1000, GRACE), "abandoned");
  assert.equal(g.usedMs, 3 * MIN);
});

test("a session that ran out before the worker noticed still starts its cooldown", () => {
  const video = S.groups.find((g) => g.id === "video")!;
  const g = freshGroupState();
  startSession(video, g, T0, 30);
  g.session!.lastSeen = T0 + 29.5 * MIN;
  const justAfter = T0 + 30 * MIN + 200; // before the end alarm fires
  assert.equal(status(video, g, justAfter), "ready", "unsettled, it looks free, so a navigation would start a new session over it");
  assert.equal(settle(video, g, justAfter, GRACE), "expired");
  assert.equal(status(video, g, justAfter), "cooldown");
  assert.equal(g.usedMs, 30 * MIN);
});
