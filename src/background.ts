import {
  DEFAULT_SETTINGS, CHALLENGE, MIN, matchGroup, emptyState, gs, rollover, status, startSession, endSession,
  remainingMs, usedMs, sessionsLeft, pauseSeconds, lengthOptions, nextResetAt, loosenings,
  BORROW, BORROW_PHRASE, canBorrow, borrow, budgetMs, requestChange, pendingStatus,
} from "./core.ts";
import type { GateInfo, GroupState, Pending, PendingView, Settings, State, Summary, SummaryRow } from "./core.ts";
import type { Message, Replies } from "./messages.ts";

const GATE = chrome.runtime.getURL("gate.html");

interface Stored { settings?: Settings; state?: State; pending?: Pending }

async function stored(...keys: (keyof Stored)[]): Promise<Stored> {
  return (await chrome.storage.local.get(keys)) as Stored;
}

async function loadSettings(): Promise<Settings> {
  return (await stored("settings")).settings ?? DEFAULT_SETTINGS;
}

// All reads and writes go through this queue so two events never clobber each other's state.
let chain: Promise<unknown> = Promise.resolve();
function withState<T>(fn: (settings: Settings, st: State, now: number) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const { settings = DEFAULT_SETTINGS, state } = await stored("settings", "state");
    const now = Date.now();
    const st = state ?? emptyState(now, settings);
    st.debt ||= {};
    rollover(st, now, settings);
    const result = await fn(settings, st, now);
    await chrome.storage.local.set({ state: st });
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await stored("settings");
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  // 1.1 lowered every cooldown to 15 min. Bring 1.0 installs in line once, without the lock.
  else if ((settings.version || 1) < 2) {
    settings.groups.forEach((g) => { g.cooldownMin = 15; });
    settings.version = 2;
    await chrome.storage.local.set({ settings });
    await chrome.storage.local.remove("pending");
  }
  setup();
});
chrome.runtime.onStartup.addListener(setup);

function setup() {
  chrome.alarms.create("tick", { periodInMinutes: 0.5 });
  tick();
}

function gateUrl(groupId: string, url: string): string {
  return `${GATE}?g=${encodeURIComponent(groupId)}&u=${encodeURIComponent(url)}`;
}

// One visit fires both webNavigation and tabs.onUpdated; only count it once.
const recent = new Map<number, { url: string; t: number }>();

// Decide what happens when a tab lands on a URL.
async function check(tabId: number, url: string | undefined) {
  if (!url || url.startsWith(GATE)) return;
  const last = recent.get(tabId);
  if (last && last.url === url && Date.now() - last.t < 2000) return;
  recent.set(tabId, { url, t: Date.now() });
  const group = matchGroup(url, await loadSettings());
  if (!group) return;
  const redirect = await withState((_s, st, now) => {
    const g = gs(st, group.id);
    const stat = status(group, g, now);
    if (stat === "active") { g.session!.lastSeen = now; return false; }
    if (stat === "ready" && !group.confirm) { startSession(group, g, now, group.sessionMin); armEnd(group.id, g); return false; }
    g.attempts += 1;
    return true;
  });
  if (redirect) chrome.tabs.update(tabId, { url: gateUrl(group.id, url) }).catch(() => {});
  else updateBadge();
}

chrome.webNavigation.onBeforeNavigate.addListener((d) => { if (d.frameId === 0) check(d.tabId, d.url); });
// Single-page apps (x.com, instagram) change URL without a full navigation.
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url) check(tabId, info.url); });
// Coming back to a tab that was left open counts as a new visit.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url) check(tabId, tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => recent.delete(tabId));

function armEnd(groupId: string, g: GroupState) {
  if (g.session) chrome.alarms.create(`end:${groupId}`, { when: g.session.end + 500 });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pending") {
    chrome.notifications?.create({
      type: "basic", iconUrl: "icons/128.png", title: "Your settings change is ready",
      message: "Open Speedbump settings to confirm it. If you skip it, it lapses in a day.", priority: 0,
    });
  }
  tick();
});

// Ends expired or abandoned sessions and sends their tabs back to the gate.
async function tick() {
  const tabs = await chrome.tabs.query({});
  const settings = await loadSettings();
  const kicked = await withState((_s, st, now) => {
    const out: [number, string][] = [];
    for (const group of settings.groups) {
      const g = st.groups[group.id];
      if (!g?.session) continue;
      const open = tabs.filter((t) => t.url && matchGroup(t.url, settings)?.id === group.id);
      if (now >= g.session.end) {
        endSession(group, g, now);
        out.push(...open.map((t): [number, string] => [t.id!, gateUrl(group.id, t.url!)]));
      } else if (open.some((t) => t.active)) {
        g.session.lastSeen = now;
      } else if (now - g.session.lastSeen > settings.idleGraceMin * MIN) {
        endSession(group, g, g.session.lastSeen);
      }
    }
    return out;
  });
  for (const [id, url] of kicked) chrome.tabs.update(id, { url }).catch(() => {});
  if (kicked.length) notifyEnd();
  updateBadge();
}

function notifyEnd() {
  chrome.notifications?.create({
    type: "basic", iconUrl: "icons/128.png", title: "Session over",
    message: "Time's up. Nice work stopping here.", priority: 0,
  });
}

async function updateBadge() {
  const { settings = DEFAULT_SETTINGS, state } = await stored("settings", "state");
  const now = Date.now();
  const ends = settings.groups.map((gr) => state?.groups?.[gr.id]?.session?.end ?? 0).filter((e) => e > now);
  const text = ends.length ? `${Math.ceil((Math.min(...ends) - now) / MIN)}m` : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#1f9d74" });
}

function rows(settings: Settings, st: State, now: number): SummaryRow[] {
  return settings.groups.map((group) => {
    const g = gs(st, group.id);
    return {
      group, status: status(group, g, now), usedMs: usedMs(g, now), remainingMs: remainingMs(group, g, now),
      sessionsLeft: sessionsLeft(group, g, now), session: g.session, cooldownUntil: g.cooldownUntil,
      attempts: g.attempts, dismissed: g.dismissed, sessions: g.sessions,
      budgetMs: budgetMs(group, g), penaltyMs: g.penaltyMs || 0, borrowedMs: g.borrowedMs || 0,
    };
  });
}

chrome.runtime.onMessage.addListener((msg: Message, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ error: String(e) }));
  return true;
});

async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<Replies[Message["type"]]> {
  const settings = await loadSettings();
  const group = "groupId" in msg ? settings.groups.find((g) => g.id === msg.groupId) : undefined;
  switch (msg.type) {
    case "gateInfo":
      if (!group) return { missing: true };
      return withState((_s, st, now): GateInfo => {
        const g = gs(st, group.id);
        return {
          group, now, status: status(group, g, now), usedMs: usedMs(g, now), remainingMs: remainingMs(group, g, now),
          sessionsLeft: sessionsLeft(group, g, now), cooldownUntil: g.cooldownUntil, attempts: g.attempts,
          dismissed: g.dismissed, pauseSec: pauseSeconds(settings, g.attempts), options: lengthOptions(group, g, now),
          resetAt: nextResetAt(now, settings.resetHour), replacement: settings.replacement,
          budgetMs: budgetMs(group, g), penaltyMs: g.penaltyMs || 0, borrowedMs: g.borrowedMs || 0,
          canBorrow: canBorrow(group, g, now), borrow: { ...BORROW, phrase: BORROW_PHRASE },
        };
      });
    case "start":
      if (!group) return { ok: false };
      return withState((_s, st, now) => {
        const g = gs(st, group.id);
        const ok = startSession(group, g, now, msg.minutes, msg.intent || "");
        if (ok) armEnd(group.id, g);
        return { ok };
      }).finally(updateBadge);
    case "dismiss":
      if (group) await withState((_s, st) => { gs(st, group.id).dismissed += 1; });
      if (!sender.tab?.id) return null;
      if (msg.replacementUrl) return chrome.tabs.update(sender.tab.id, { url: msg.replacementUrl });
      return chrome.tabs.remove(sender.tab.id);
    case "end":
      if (group) await withState((_s, st, now) => { endSession(group, gs(st, group.id), now); });
      await tick();
      return { ok: true };
    case "pill": {
      const url = sender.tab?.url;
      const match = url ? matchGroup(url, settings) : null;
      if (!match) return null;
      return withState((_s, st) => {
        const g = gs(st, match.id);
        return g.session ? { groupId: match.id, name: match.name, end: g.session.end, intent: g.session.intent } : null;
      });
    }
    case "summary":
      return withState(async (_s, st, now): Promise<Summary> => ({
        now, rows: rows(settings, st, now), history: st.history, day: st.day, debt: st.debt,
        pending: await currentPending(settings, now), lockHours: settings.lockHours ?? 24,
      }));
    case "saveSettings": {
      const looser = loosenings(settings, msg.settings);
      if (!looser.length) {
        await chrome.storage.local.set({ settings: msg.settings });
        tick();
        return { ok: true };
      }
      if (msg.challenge !== CHALLENGE) return { needsChallenge: looser };
      // Looser rules never apply on the spot. They wait out the lock and then need a second yes.
      const pending = requestChange(settings, msg.settings, Date.now());
      await chrome.storage.local.set({ pending });
      chrome.alarms.create("pending", { when: pending.readyAt });
      return { pending: { ...pending, status: "waiting" } };
    }
    case "cancelPending":
      await chrome.storage.local.remove("pending");
      chrome.alarms.clear("pending");
      return { ok: true };
    case "applyPending": {
      const pending = await currentPending(settings, Date.now());
      if (pending?.status !== "ready") return { ok: false, error: "Not ready" };
      if (msg.challenge !== CHALLENGE) return { ok: false, error: "Wrong sentence" };
      await chrome.storage.local.set({ settings: pending.settings });
      await chrome.storage.local.remove("pending");
      tick();
      return { ok: true };
    }
    case "borrowStart":
      if (!group) return { ok: false };
      return withState((_s, st, now) => {
        const g = gs(st, group.id);
        if (!canBorrow(group, g, now)) return { ok: false as const };
        if (!g.borrowStartedAt || now - g.borrowStartedAt > 15 * MIN) g.borrowStartedAt = now;
        return { ok: true as const, startedAt: g.borrowStartedAt };
      });
    case "borrow":
      if (!group) return { ok: false };
      return withState((_s, st, now) => {
        const g = gs(st, group.id);
        const waited = now - (g.borrowStartedAt || now) >= (BORROW.waitSec - 2) * 1000;
        if (!waited || msg.phrase !== BORROW_PHRASE || (msg.reason || "").trim().length < BORROW.minReason) return { ok: false };
        const ms = borrow(group, g, now);
        if (!ms) return { ok: false };
        g.borrowReason = msg.reason.trim().slice(0, 300);
        st.debt[group.id] = (st.debt[group.id] || 0) + ms;
        armEnd(group.id, g);
        return { ok: true };
      }).finally(updateBadge);
  }
}

// Drops requests that lapsed or that no longer match the current rules.
async function currentPending(settings: Settings, now: number): Promise<PendingView | null> {
  const { pending } = await stored("pending");
  const st = pendingStatus(pending, settings, now);
  if (!st || !pending) return null;
  if (st === "expired" || st === "stale") {
    await chrome.storage.local.remove("pending");
    return { status: st, changes: pending.changes };
  }
  return { ...pending, status: st };
}

setup();
