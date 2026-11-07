// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, loosenings, matchGroup, searchRoute, upgradeToV3 } from "../src/core.ts";
import type { Group, Settings } from "../src/core.ts";

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const video = DEFAULT_SETTINGS.groups.find((g) => g.id === "video")!;
const reddit = DEFAULT_SETTINGS.groups.find((g) => g.id === "reddit")!;
const instagram = DEFAULT_SETTINGS.groups.find((g) => g.id === "instagram")!;
const redirect = (url: string, group: Group) => searchRoute(url, group)?.redirect;

// The groups a version 2 install was given.
function v2(): Settings {
  const s = clone(DEFAULT_SETTINGS);
  s.version = 2;
  for (const g of s.groups) {
    delete g.searchOnly;
    if (g.id === "reddit") g.dailyMin = 45;
  }
  return s;
}

test("Reddit has its own 15 minutes a day, apart from YouTube", () => {
  assert.equal(reddit.dailyMin, 15);
  assert.notEqual(matchGroup("https://www.reddit.com/", DEFAULT_SETTINGS)?.id, matchGroup("https://www.youtube.com/", DEFAULT_SETTINGS)?.id);
});

test("YouTube keeps search, results and videos, and nothing else", () => {
  for (const url of ["https://www.youtube.com/", "https://www.youtube.com/results?search_query=bridges", "https://www.youtube.com/watch?v=abc", "https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.org"]) {
    assert.equal(redirect(url, video), null, url);
  }
  for (const path of ["feed/subscriptions", "feed/history", "shorts/abc", "@somechannel", "channel/UC123", "playlist?list=abc", "gaming"]) {
    assert.equal(redirect(`https://www.youtube.com/${path}`, video), "https://www.youtube.com/", path);
  }
});

test("Reddit keeps search and threads, and nothing else", () => {
  for (const path of ["", "search/?q=boots", "r/hiking/search/?q=boots", "r/hiking/comments/abc/best_boots/", "comments/abc", "user/someone/comments/abc", "r/hiking/s/AbC", "gallery/abc", "media?url=x"]) {
    assert.equal(redirect(`https://www.reddit.com/${path}`, reddit), null, path);
  }
  for (const path of ["r/popular/", "r/all", "r/hiking/", "r/hiking/top/", "best", "new", "user/someone", "submit", "notifications", "settings", "answers"]) {
    assert.equal(redirect(`https://www.reddit.com/${path}`, reddit), "https://www.reddit.com/", path);
  }
});

test("other hostnames of a site land on the right one, keeping the path if it stays open", () => {
  assert.equal(redirect("https://m.youtube.com/watch?v=abc", video), "https://www.youtube.com/watch?v=abc");
  assert.equal(redirect("https://new.reddit.com/r/x/comments/abc/", reddit), "https://www.reddit.com/r/x/comments/abc/");
  assert.equal(redirect("https://sh.reddit.com/r/popular", reddit), "https://www.reddit.com/");
  assert.equal(redirect("https://old.reddit.com/r/x/comments/abc/", reddit), null, "old Reddit stays old");
  assert.equal(redirect("https://old.reddit.com/r/popular", reddit), "https://old.reddit.com/");
  assert.equal(searchRoute("https://old.reddit.com/", reddit)?.action, "https://old.reddit.com/search/");
});

test("a redirect always lands somewhere that stays put", () => {
  const urls = ["https://www.youtube.com/feed/you", "https://m.youtube.com/shorts/abc", "https://youtube.com/", "https://new.reddit.com/", "https://np.reddit.com/r/x/comments/a/", "https://old.reddit.com/r/all"];
  for (const url of urls) {
    const group = url.includes("youtube") ? video : reddit;
    const to = redirect(url, group);
    assert.ok(to, url);
    assert.equal(redirect(to, group), null, `${url} goes to ${to}, which moves again`);
  }
});

test("the search page is marked, and points at the site's own search", () => {
  const route = searchRoute("https://www.youtube.com/?app=desktop", video)!;
  assert.equal(route.atHome, true);
  assert.equal(route.redirect, null);
  assert.equal(route.action, "https://www.youtube.com/results");
  assert.equal(route.param, "search_query");
  assert.equal(searchRoute("https://www.youtube.com/watch?v=abc", video)!.atHome, false);
});

test("sites and groups without search-only mode keep the gate", () => {
  assert.equal(searchRoute("https://www.tiktok.com/foryou", video), null, "TikTok shares YouTube's timer, not its search page");
  assert.equal(searchRoute("https://www.instagram.com/", instagram), null);
  assert.equal(searchRoute("https://www.youtube.com/", { ...video, searchOnly: false }), null);
  assert.equal(searchRoute("https://studio.youtube.com/", video), null);
  assert.equal(searchRoute("https://chat.reddit.com/", reddit), null);
});

test("the upgrade moves a stock install onto the new rules", () => {
  const s = v2();
  upgradeToV3(s);
  assert.equal(s.version, 3);
  assert.deepEqual(s.groups, DEFAULT_SETTINGS.groups, "ends up the same as a fresh install");
});

test("the upgrade splits Reddit out of a shared group, and that group keeps its limits", () => {
  const s = v2();
  s.groups = s.groups.filter((g) => g.id !== "reddit");
  const shared = s.groups.find((g) => g.id === "video")!;
  shared.sites.push("reddit.com");
  upgradeToV3(s);
  assert.deepEqual(shared.sites, ["youtube.com", "tiktok.com"]);
  assert.equal(shared.dailyMin, 90);
  assert.equal(matchGroup("https://www.reddit.com/", s)?.dailyMin, 15);
  assert.equal(matchGroup("https://www.reddit.com/", s)?.searchOnly, true);
  assert.equal(matchGroup("https://www.youtube.com/", s)?.id, "video");
});

test("the upgrade doesn't reuse an id another group has", () => {
  const s = v2();
  const shared = s.groups.find((g) => g.id === "reddit")!;
  shared.sites.push("news.ycombinator.com");
  upgradeToV3(s);
  assert.deepEqual(shared.sites, ["news.ycombinator.com"], "the other site stays limited");
  assert.equal(matchGroup("https://www.reddit.com/", s)?.id, "reddit-own");
});

test("the upgrade only ever tightens Reddit", () => {
  const s = v2();
  const r = s.groups.find((g) => g.id === "reddit")!;
  r.dailyMin = 10;
  r.sessionMin = 5;
  r.enabled = false;
  upgradeToV3(s);
  assert.equal(r.dailyMin, 10);
  assert.equal(r.sessionMin, 5);
  assert.equal(r.enabled, true);
});

test("the upgrade finds a Reddit group listed by subdomain or under a looser limit", () => {
  const s = v2();
  const r = s.groups.find((g) => g.id === "reddit")!;
  r.id = "mine";
  r.sites = ["old.reddit.com", "www.reddit.com"];
  r.dailyMin = 120;
  r.sessionMin = 60;
  upgradeToV3(s);
  assert.deepEqual(r.sites, ["reddit.com"]);
  assert.equal(r.dailyMin, 15);
  assert.equal(r.sessionMin, 15);
  assert.equal(s.groups.filter((g) => g.sites.includes("reddit.com")).length, 1);
});

test("turning search-only on is looser, and turning it off is instant", () => {
  const on = clone(DEFAULT_SETTINGS);
  const off = clone(on);
  off.groups.find((g) => g.id === "video")!.searchOnly = false;
  assert.deepEqual(loosenings(on, off), []);
  assert.deepEqual(loosenings(off, on), ['"YouTube and TikTok" keeps search when time runs out']);
});

test("moving a site into a search-only group counts as loosening", () => {
  const s = clone(DEFAULT_SETTINGS);
  const strict: Group = { ...clone(video), id: "strict", name: "Strict", sites: ["youtube.com"], searchOnly: false };
  s.groups.push(strict);
  s.groups.find((g) => g.id === "video")!.sites = ["tiktok.com"];
  const n = clone(s);
  n.groups.find((g) => g.id === "video")!.sites = ["tiktok.com", "youtube.com"];
  assert.ok(loosenings(s, n).some((c) => c.includes('"youtube.com" moves')), loosenings(s, n).join("; "));
});
