// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS as S, MIN, matchGroup, isAllowed, freshGroupState, status, startSession, endSession,
  remainingMs, sessionsLeft, pauseSeconds, lengthOptions, emptyState, gs, rollover, loosenings,
  canBorrow, borrow, requestChange, pendingStatus, HOUR, normalize, cooldownUntil,
  makeAgentProblem, agentAnswer, checkAgentAnswer, agentText, agentPassUrl,
  NUCLEAR, nuclearOn, startNuclear,
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

test("nuclear mode runs for the chosen time, 30 min by default", () => {
  const st = emptyState(T0, S);
  assert.equal(NUCLEAR.defaultMin, 30);
  assert.equal(nuclearOn(st, T0), false);
  assert.equal(startNuclear(st, S, T0, NUCLEAR.defaultMin), T0 + 30 * MIN);
  assert.equal(nuclearOn(st, T0 + 29 * MIN), true);
  assert.equal(nuclearOn(st, T0 + 30 * MIN), false);
});

test("nuclear mode can't be shortened, only pushed out", () => {
  const st = emptyState(T0, S);
  startNuclear(st, S, T0, 120);
  assert.equal(startNuclear(st, S, T0 + MIN, 15), T0 + 120 * MIN, "a shorter restart changes nothing");
  assert.equal(startNuclear(st, S, T0 + MIN, 240), T0 + MIN + 240 * MIN);
});

test("nuclear mode keeps its length inside the limits", () => {
  const at = (minutes: number) => (startNuclear(emptyState(T0, S), S, T0, minutes) - T0) / MIN;
  assert.equal(at(99_999), NUCLEAR.maxMin);
  assert.equal(at(-5), 1);
  assert.equal(at(Number.NaN), NUCLEAR.defaultMin);
});

test("nuclear mode ends running sessions and refunds what's left", () => {
  const st = emptyState(T0, S);
  const g = gs(st, "x");
  startSession(x, g, T0, 15);
  g.session!.lastSeen = T0 + 5 * MIN;
  startNuclear(st, S, T0 + 5 * MIN, 30);
  assert.equal(g.session, null);
  assert.equal(remainingMs(x, g, T0 + 5 * MIN), 40 * MIN);
  assert.equal(g.fullSessions, 0, "being cut off doesn't lengthen the next pause");
});

test("nuclear mode charges a session left behind only up to when it was last seen", () => {
  const st = emptyState(T0, S);
  const g = gs(st, "x");
  startSession(x, g, T0, 15);
  g.session!.lastSeen = T0 + 3 * MIN;
  startNuclear(st, S, T0 + 10 * MIN, 30);
  assert.equal(g.session, null);
  assert.equal(g.usedMs, 3 * MIN);
});

test("nuclear mode survives a new day and old saved state starts with it off", () => {
  const st = emptyState(T0, S);
  startNuclear(st, S, T0, 60);
  const justAfterMidnight = new Date(2026, 9, 29, 0, 5).getTime();
  st.nuclearUntil = justAfterMidnight + 30 * MIN;
  assert.ok(rollover(st, justAfterMidnight, S));
  assert.equal(nuclearOn(st, justAfterMidnight), true);
  const legacy = normalize({ day: "2026-10-29", groups: {}, history: {}, debt: {} } as never);
  assert.equal(legacy.nuclearUntil, 0);
  assert.equal(nuclearOn(undefined, T0), false);
});

test("agent pass: Dirichlet integral, exact fractions in any form", () => {
  // ∭ xyz over x/2 + y/3 + z/5 ≤ 1 is 2²·3²·5² / 6! = 900/720 = 5/4.
  const one = { a: 2, b: 3, c: 5, terms: [{ k: 1, p: 1, q: 1, r: 1 }] };
  assert.deepEqual(agentAnswer(one), [5n, 4n]);
  assert.ok(checkAgentAnswer(one, "5/4"));
  assert.ok(checkAgentAnswer(one, " 10 / 8 "));
  assert.equal(checkAgentAnswer(one, "1.25"), false, "decimals don't count");
  assert.equal(checkAgentAnswer(one, "5/0"), false);
  assert.equal(checkAgentAnswer(one, "4/5"), false);
  // Sums of terms add up.
  const two = { ...one, terms: [one.terms[0], { k: 3, p: 1, q: 1, r: 1 }] };
  assert.deepEqual(agentAnswer(two), [5n, 1n]);
  assert.ok(checkAgentAnswer(two, "5"));
});

test("agent problems are random and spelled out", () => {
  let seed = 1;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pr = makeAgentProblem(rand);
  assert.equal(pr.terms.length, 5);
  const { text, latex } = agentText(pr);
  assert.match(text, new RegExp(`x/${pr.a} \\+ y/${pr.b} \\+ z/${pr.c}`));
  assert.match(latex, /^\\iiint_T/);
  const [n, d] = agentAnswer(pr);
  assert.ok(checkAgentAnswer(pr, `${n}/${d}`));
  assert.ok(checkAgentAnswer(pr, `${2n * n}/${2n * d}`));
  assert.notDeepEqual(makeAgentProblem(rand), pr);
});

test("agent pass URL round-trips the target", () => {
  const u = agentPassUrl("https://x.com/someone?a=1&b=2");
  assert.equal(u, "https://example.com/#speedbump=https%3A%2F%2Fx.com%2Fsomeone%3Fa%3D1%26b%3D2");
  assert.equal(decodeURIComponent(u.split("#speedbump=")[1]), "https://x.com/someone?a=1&b=2");
});
