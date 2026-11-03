// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS as S, MIN, emptyState, gs, startSession, endSession, rollover, tabsWithoutSession } from "../src/core.ts";

const x = S.groups.find((g) => g.id === "x")!;
const T0 = new Date(2026, 9, 28, 10, 0).getTime();
const tab = (id: number, url: string, more: Partial<{ active: boolean; status: string }> = {}) => ({ id, url, active: true, status: "complete", ...more });
const ids = (tabs: { id?: number }[]) => tabs.map((t) => t.id);

test("a limited site in front with no session is caught", () => {
  const st = emptyState(T0, S);
  const tabs = [tab(1, "https://x.com/home"), tab(2, "https://example.com/"), tab(3, "https://music.youtube.com/")];
  assert.deepEqual(ids(tabsWithoutSession(tabs, S, st, T0)), [1], "unlimited and allow-listed sites are left alone");
});

test("a running session keeps its tabs", () => {
  const st = emptyState(T0, S);
  startSession(x, gs(st, "x"), T0, 15);
  assert.deepEqual(ids(tabsWithoutSession([tab(1, "https://x.com/home")], S, st, T0 + 5 * MIN)), []);
});

test("pressing End leaves the tab without a session", () => {
  const st = emptyState(T0, S);
  const g = gs(st, "x");
  startSession(x, g, T0, 15);
  endSession(x, g, T0 + 2 * MIN);
  assert.deepEqual(ids(tabsWithoutSession([tab(1, "https://x.com/home")], S, st, T0 + 2 * MIN)), [1]);
});

test("a new day drops the running session, so its tab is caught", () => {
  const st = emptyState(T0, S);
  const late = new Date(2026, 9, 28, 23, 55).getTime();
  startSession(x, gs(st, "x"), late, 15);
  const after = late + 10 * MIN;
  rollover(st, after, S);
  assert.deepEqual(ids(tabsWithoutSession([tab(1, "https://x.com/home")], S, st, after)), [1]);
});

test("background and loading tabs are left to the navigation listeners", () => {
  const st = emptyState(T0, S);
  const tabs = [tab(1, "https://x.com/", { active: false }), tab(2, "https://x.com/", { status: "loading" })];
  assert.deepEqual(ids(tabsWithoutSession(tabs, S, st, T0)), []);
});
