// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, loosenings, matchGroup } from "../src/core.ts";
import type { Group, Settings } from "../src/core.ts";

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const news: Group = { id: "news", name: "News", sites: ["news.example"], confirm: false, sessionMin: 30, dailyMin: 120, cooldownMin: 5, enabled: true };
// An older, easier group that sits above the defaults in the list.
const withNews = (): Settings => {
  const s = clone(DEFAULT_SETTINGS);
  s.groups.unshift(clone(news));
  return s;
};

test("adding a site to an earlier group with easier limits counts as loosening", () => {
  const s = withNews();
  const n = clone(s);
  n.groups[0].sites.push("reddit.com");
  assert.equal(matchGroup("https://www.reddit.com/", n)?.id, "news", "the earlier group wins the match");
  assert.deepEqual(loosenings(s, n), ['"reddit.com" moves from "Reddit" to "News"']);
});

test("a subdomain or path of a limited site can't move either", () => {
  const s = withNews();
  const n = clone(s);
  n.groups[0].sites.push("old.reddit.com", "x.com/home");
  assert.deepEqual(loosenings(s, n), ['"old.reddit.com" moves from "Reddit" to "News"', '"x.com/home" moves from "X" to "News"']);
});

test("switching an easier group back on that lists a site counts too", () => {
  const s = withNews();
  s.groups[0].enabled = false;
  s.groups[0].sites.push("instagram.com");
  const n = clone(s);
  n.groups[0].enabled = true;
  assert.deepEqual(loosenings(s, n), ['"instagram.com" moves from "Instagram" to "News"']);
});

test("moving a site to a group that's as strict or stricter saves right away", () => {
  const s = clone(DEFAULT_SETTINGS);
  const n = clone(s);
  // Instagram comes before Facebook and has the same limits: merging them shares one budget.
  n.groups.find((g) => g.id === "instagram")!.sites.push("facebook.com");
  assert.deepEqual(loosenings(s, n), []);
  // X is stricter than the video group on every limit.
  const m = clone(s);
  m.groups.find((g) => g.id === "x")!.sites.push("tiktok.com");
  assert.deepEqual(loosenings(s, m), []);
});

test("adding a site to a later group changes nothing, since the earlier one still matches", () => {
  const s = clone(DEFAULT_SETTINGS);
  const n = clone(s);
  n.groups.find((g) => g.id === "video")!.sites.push("x.com");
  assert.equal(matchGroup("https://x.com/", n)?.id, "x");
  assert.deepEqual(loosenings(s, n), []);
});
