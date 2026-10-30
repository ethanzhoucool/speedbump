// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS as S, MIN, matchGroup, isAllowed, freshGroupState, status, startSession, endSession,
  remainingMs, sessionsLeft, pauseSeconds, lengthOptions, emptyState, gs, rollover, loosenings,
  canBorrow, borrow, requestChange, pendingStatus, HOUR, normalize, cooldownUntil,
} from "../src/core.ts";
import type { Settings } from "../src/core.ts";

const x = S.groups.find((g) => g.id === "x")!;
const copy = (): Settings => JSON.parse(JSON.stringify(S));
const T0 = new Date(2026, 9, 28, 10, 0).getTime();

test("matching: domains, subdomains, paths, allowlist", () => {
  assert.equal(matchGroup("https://x.com/home", S)?.id, "x");
  assert.equal(matchGroup("https://mobile.twitter.com/", S)?.id, "x");
  assert.equal(matchGroup("https://www.facebook.com/", S)?.id, "facebook");
  assert.equal(matchGroup("https://old.reddit.com/r/news", S)?.id, "reddit");
  assert.equal(matchGroup("https://www.youtube.com/watch?v=1", S)?.id, "video");
  assert.equal(matchGroup("https://music.youtube.com/", S), null);
  assert.ok(isAllowed("https://music.youtube.com/watch?v=1", S));
  assert.equal(matchGroup("https://notx.com/", S), null);
  assert.equal(matchGroup("chrome://extensions", S), null);
});

test("three 15 min sessions with a cooldown between each", () => {
  const g = freshGroupState();
  let now = T0;
  assert.equal(status(x, g, now), "ready");
  assert.equal(sessionsLeft(x, g, now), 3);
  assert.ok(startSession(x, g, now, 15));
  assert.equal(status(x, g, now + 5 * MIN), "active");
  assert.equal(startSession(x, g, now, 15), false, "no double start");

  now += 15 * MIN;
  endSession(x, g, now);
  assert.equal(status(x, g, now), "cooldown");
  assert.equal(remainingMs(x, g, now), 30 * MIN);
  assert.equal(status(x, g, now + 14 * MIN), "cooldown");

  now += 15 * MIN;
  assert.equal(status(x, g, now), "ready");
  startSession(x, g, now, 15); now += 15 * MIN; endSession(x, g, now);
  now += 15 * MIN;
  startSession(x, g, now, 15); now += 15 * MIN; endSession(x, g, now);
  assert.equal(status(x, g, now), "exhausted");
  assert.equal(g.sessions, 3);
});

test("ending early refunds the unused minutes but still cools down", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  endSession(x, g, T0 + 4 * MIN);
  assert.equal(remainingMs(x, g, T0 + 4 * MIN), 41 * MIN);
  assert.equal(status(x, g, T0 + 10 * MIN), "cooldown");
});

test("session is capped by session length and remaining budget", () => {
  const g = freshGroupState();
  g.usedMs = 40 * MIN;
  startSession(x, g, T0, 15);
  assert.equal(g.session!.end - g.session!.start, 5 * MIN);
  assert.deepEqual(lengthOptions(x, freshGroupState(), T0), [5, 10, 15]);
});

test("pause grows only with sessions that used all their time", () => {
  assert.equal(pauseSeconds(S, 0), 5);
  assert.equal(pauseSeconds(S, 2), 15);
  assert.equal(pauseSeconds(S, 50), 30);
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  endSession(x, g, T0 + 5 * MIN);
  assert.equal(g.fullSessions, 0, "ending early doesn't count");
  startSession(x, g, T0 + 20 * MIN, 15);
  endSession(x, g, T0 + 40 * MIN);
  assert.equal(g.fullSessions, 1, "running out the clock does");
});

test("new day archives usage and resets", () => {
  const st = emptyState(T0, S);
  const g = gs(st, "x");
  startSession(x, g, T0, 15);
  g.attempts = 2;
  const tomorrow = T0 + 24 * 60 * MIN;
  assert.ok(rollover(st, tomorrow, S));
  assert.equal(st.history["2026-10-28"].x.usedMs, 15 * MIN);
  assert.deepEqual(st.groups, {});
});

test("loosening detection", () => {
  const n = copy();
  assert.deepEqual(loosenings(S, n), []);
  n.groups[0].cooldownMin = 30; // stricter
  n.groups[0].sessionMin = 10;
  assert.deepEqual(loosenings(S, n), []);
  n.groups[0].dailyMin = 60;
  n.groups[1].confirm = false;
  n.allowlist.push("x.com/messages");
  assert.equal(loosenings(S, n).length, 3);
});

test("borrowing skips the cooldown once and comes out of tomorrow", () => {
  const st = emptyState(T0, S);
  const g = gs(st, "x");
  assert.equal(canBorrow(x, g, T0), false, "nothing to skip while ready");
  startSession(x, g, T0, 15);
  endSession(x, g, T0 + 15 * MIN);
  const t = T0 + 20 * MIN;
  assert.equal(status(x, g, t), "cooldown");
  assert.equal(borrow(x, g, t), 10 * MIN);
  st.debt.x = 10 * MIN;
  assert.equal(status(x, g, t + MIN), "active");
  assert.equal(remainingMs(x, g, t + 10 * MIN), 30 * MIN, "borrowed session does not eat today's budget");
  endSession(x, g, t + 10 * MIN);
  assert.equal(canBorrow(x, g, t + 11 * MIN), false, "only once a day");
  rollover(st, T0 + 24 * HOUR, S);
  assert.equal(remainingMs(x, gs(st, "x"), T0 + 24 * HOUR), 35 * MIN);
  assert.equal(st.history["2026-10-28"].x.borrowedMs, 10 * MIN);
});

test("looser changes wait, then lapse if not confirmed", () => {
  const n = copy();
  n.groups[0].dailyMin = 90;
  const p = requestChange(S, n, T0);
  assert.equal(p.changes.length, 1);
  assert.equal(pendingStatus(p, S, T0 + 23 * HOUR), "waiting");
  assert.equal(pendingStatus(p, copy(), T0 + 25 * HOUR), "ready");
  assert.equal(pendingStatus(p, S, T0 + 49 * HOUR), "expired");
  const changed = copy();
  changed.groups[1].dailyMin = 30;
  assert.equal(pendingStatus(p, changed, T0 + 25 * HOUR), "stale");
});

test("shortening the lock or moving the reset hour counts as looser", () => {
  const n = copy();
  n.lockHours = 1;
  n.resetHour = 4;
  assert.equal(loosenings(S, n).length, 2);
});

test("a running cooldown follows the current setting", () => {
  const g = freshGroupState();
  startSession(x, g, T0, 15);
  endSession(x, g, T0 + MIN);
  const long = { ...x, cooldownMin: 60 };
  assert.equal(status(long, g, T0 + 30 * MIN), "cooldown");
  assert.equal(status(x, g, T0 + 30 * MIN), "ready", "lowering it to 15 frees it right away");
  assert.equal(cooldownUntil(x, g), T0 + 16 * MIN);
});

test("state saved by 1.0 is upgraded in place", () => {
  const legacy = { day: "2026-10-29", history: {}, groups: { x: { usedMs: 82_333, session: null, cooldownUntil: T0 + HOUR, attempts: 1, dismissed: 0, sessions: 1 } } };
  const st = normalize(legacy as never);
  const g = st.groups.x;
  assert.equal(g.extraMs, 0);
  assert.equal(g.cooldownFrom, 0);
  assert.equal("cooldownUntil" in g, false);
  assert.deepEqual(st.debt, {});
  assert.equal(status(x, g, T0), "ready");
});
