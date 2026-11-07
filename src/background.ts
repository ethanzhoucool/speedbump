import {
  DEFAULT_SETTINGS, CHALLENGE, MIN, matchGroup, emptyState, gs, rollover, status, startSession, endSession,
  tabsWithoutSession,
  remainingMs, usedMs, sessionsLeft, pauseSeconds, lengthOptions, nextResetAt, loosenings,
  clampSession,
  BORROW, BORROW_PHRASE, canBorrow, borrow, budgetMs, requestChange, pendingStatus, normalize, cooldownUntil,
  AGENT, makeAgentProblem, agentText, checkAgentAnswer, agentPassUrl, nuclearOn, startNuclear,
  settle, searchRoute, upgradeToV3,
} from "./core.ts";
import type { AgentProblem, GateInfo, Group, GroupState, Pending, PendingView, Settings, State, Summary, SummaryRow } from "./core.ts";
import type { Message, Replies } from "./messages.ts";

const GATE = chrome.runtime.getURL("gate.html");

interface Stored { settings?: Settings; state?: State; pending?: Pending }

async function stored(...keys: (keyof Stored)[]): Promise<Stored> {
  return (await chrome.storage.local.get(keys)) as Stored;
}

// Settings and state live in memory while the worker is awake, so a navigation doesn't wait on storage reads.
// Settings can change from the options page, so storage changes refresh the copy.
let settingsCache: Settings | undefined;
let stateCache: State | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) settingsCache = changes.settings.newValue as Settings | undefined;
});

async function loadSettings(): Promise<Settings> {
  await ready;
  settingsCache ??= (await stored("settings")).settings ?? DEFAULT_SETTINGS;
  return settingsCache;
}

// All reads and writes go through this queue so two events never clobber each other's state.
let chain: Promise<unknown> = Promise.resolve();
function withState<T>(fn: (settings: Settings, st: State, now: number) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const settings = await loadSettings();
    // Only withState writes state, so the in-memory copy is always current.
    stateCache ??= (await stored("state")).state;
    const now = Date.now();
    const st = normalize(stateCache ?? emptyState(now, settings));
    stateCache = st;
    rollover(st, now, settings);
    // Stricter rules apply to a session that's already running, too.
    for (const group of settings.groups) {
      const g = st.groups[group.id];
      if (g && clampSession(group, g, now)) armEnd(group.id, g);
    }
    const result = await fn(settings, st, now);
    await chrome.storage.local.set({ state: st });
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

// Runs every time the worker starts, so an update applies even if onInstalled was missed.
async function migrate() {
  const { settings } = await stored("settings");
  if (!settings) return chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  // 1.1 lowered every cooldown to 15 min. Bring 1.0 installs in line once, without the lock.
  if ((settings.version || 1) < 2) {
    settings.groups.forEach((g) => { g.cooldownMin = 15; });
    settings.version = 2;
    settings.lockHours ??= 24;
    await chrome.storage.local.set({ settings });
    await chrome.storage.local.remove("pending");
  }
  // A looser request made before this goes stale by itself, because the rules it was based on changed.
  if (settings.version < 3) {
    upgradeToV3(settings);
    await chrome.storage.local.set({ settings });
  }
}

const ready = migrate();

// Agent passes are per tab and kept apart from State, so they can't move any budget, cooldown or count.
// storage.session survives the worker sleeping, and content scripts can't read it, so answers stay hidden.
interface AgentTab { groupId: string; end: number }
interface AgentAsk { groupId: string; problem: AgentProblem; expiresAt: number }
interface AgentStore { agentTabs?: Record<string, AgentTab>; agentAsks?: Record<string, AgentAsk> }

async function agentStore(): Promise<Required<AgentStore>> {
  const s = (await chrome.storage.session.get(["agentTabs", "agentAsks"])) as AgentStore;
  return { agentTabs: s.agentTabs ?? {}, agentAsks: s.agentAsks ?? {} };
}

async function agentAllowed(tabId: number, groupId: string): Promise<boolean> {
  const t = (await agentStore()).agentTabs[tabId];
  return !!t && t.groupId === groupId && Date.now() < t.end;
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

async function setup() {
  await ready;
  chrome.alarms.create("tick", { periodInMinutes: 0.5 });
  tick();
}

function gateUrl(groupId: string, url: string): string {
  return `${GATE}?g=${encodeURIComponent(groupId)}&u=${encodeURIComponent(url)}&agent_pass=${encodeURIComponent(agentPassUrl(url))}`;
}

// Reads the cached state directly because going through withState would write to storage on every check.
async function nuclearActive(): Promise<boolean> {
  return nuclearOn(stateCache ?? (await stored("state")).state, Date.now());
}

const closing = new Set<number>();

// Closing a window's only tab closes the window, and on Windows or Linux closing the last window quits
// Chrome. A restored session would then quit it again, so a new tab stays behind.
async function closeTab(tabId: number) {
  if (closing.has(tabId)) return;
  closing.add(tabId);
  try {
    const { windowId } = await chrome.tabs.get(tabId);
    const inWindow = await chrome.tabs.query({ windowId });
    if (inWindow.length === 1) await chrome.tabs.create({ windowId }).catch(() => {});
    await chrome.tabs.remove(tabId);
  } catch {
    // The tab is already gone, or it's being dragged and the next tick tries again.
  } finally {
    closing.delete(tabId);
  }
}

// One visit fires both webNavigation and tabs.onUpdated; only count it once.
const recent = new Map<number, { url: string; t: number }>();

// Where the worker itself just sent a tab whose session ran out. Arriving there isn't a visit. With no
// cooldown it would otherwise start the next session straight away, so sessions would never stop.
const sentHome = new Map<number, string>();

// Decide what happens when a tab lands on a URL. `passive` means nobody just went there: it's a tab that was
// already open in front.
async function check(tabId: number, url: string | undefined, passive = false) {
  if (!url) return;
  if (sentHome.get(tabId) === url) passive = true;
  else sentHome.delete(tabId);
  // The gate leads straight to the site, so nuclear mode closes it too.
  if (url.startsWith(GATE)) {
    if (await nuclearActive()) closeTab(tabId);
    return;
  }
  const last = recent.get(tabId);
  if (last && last.url === url && Date.now() - last.t < 2000) return;
  recent.set(tabId, { url, t: Date.now() });
  const group = matchGroup(url, await loadSettings());
  if (!group) return;
  // Checked before agent passes, because nuclear mode has no exceptions.
  if (await nuclearActive()) return closeTab(tabId);
  if (await agentAllowed(tabId, group.id)) return;
  const route = searchRoute(url, group);
  const outcome = await withState((s, st, now) => {
    const g = live(st, group, s, now);
    const stat = status(group, g, now);
    if (stat === "active") { g.session!.lastSeen = now; return "open"; }
    // When a cooldown ends, a tab being read stays as it is. Starting a session is for an actual visit.
    if (route && (stat !== "ready" || passive)) return "search";
    if (stat === "ready" && !group.confirm) { startSession(group, g, now, group.sessionMin); armEnd(group.id, g); return "open"; }
    g.attempts += 1;
    return "gate";
  });
  if (outcome === "gate") { chrome.tabs.update(tabId, { url: gateUrl(group.id, url) }).catch(() => {}); return; }
  if (outcome === "search" && route?.redirect) { chrome.tabs.update(tabId, { url: route.redirect }).catch(() => {}); return; }
  // The page stays loaded, so its content script has to hear that the mode may have changed.
  if (route) chrome.tabs.sendMessage(tabId, { type: "searchOnlyChanged" }).catch(() => {});
  if (outcome === "open") updateBadge();
}

chrome.webNavigation.onBeforeNavigate.addListener((d) => { if (d.frameId === 0) check(d.tabId, d.url); });
// Single-page apps (x.com, instagram) change URL without a full navigation.
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url) check(tabId, info.url); });
// Coming back to a tab that was left open counts as a new visit.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url) check(tabId, tab.url);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  recent.delete(tabId);
  sentHome.delete(tabId);
  const { agentTabs, agentAsks } = await agentStore();
  if (!(tabId in agentTabs) && !(tabId in agentAsks)) return;
  delete agentTabs[tabId];
  delete agentAsks[tabId];
  await chrome.storage.session.set({ agentTabs, agentAsks });
});

// A group's state with any session that ran out or was left behind (while the worker or the laptop
// slept) settled first, so its time counts and its cooldown starts before anything reads the status.
function live(st: State, group: Group, settings: Settings, now: number): GroupState {
  const g = gs(st, group.id);
  settle(group, g, now, settings.idleGraceMin * MIN);
  return g;
}

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
  // Catches tabs that no navigation reports: ones already open, restored at startup, or newly limited.
  // One at a time, so closeTab sees how many tabs are really left in the window.
  if (await nuclearActive()) {
    for (const t of tabs) {
      if (t.url && (t.url.startsWith(GATE) || matchGroup(t.url, settings))) await closeTab(t.id!);
    }
  }
  const { agentTabs } = await agentStore();
  const passed = (t: chrome.tabs.Tab) => (agentTabs[t.id!]?.end ?? 0) > Date.now();
  const { kicked, finishing, loose } = await withState((_s, st, now) => {
    const out: [number, string][] = [];
    const finishing: number[] = [];
    for (const group of settings.groups) {
      const g = st.groups[group.id];
      if (!g?.session) continue;
      const open = tabs.filter((t) => t.url && !passed(t) && matchGroup(t.url, settings)?.id === group.id);
      // Settle before marking the session seen. After a sleep the tab is still in front, and marking it
      // seen first would charge the whole time away as used.
      const ended = settle(group, g, now, settings.idleGraceMin * MIN);
      if (ended === "expired") {
        for (const t of open) {
          const route = searchRoute(t.url!, group);
          // A video or thread stays open so it can be finished. Only the page around it goes.
          if (route && !route.atHome && !route.redirect) { finishing.push(t.id!); continue; }
          if (route) sentHome.set(t.id!, route.home);
          out.push([t.id!, route?.home ?? gateUrl(group.id, t.url!)]);
        }
      }
      else if (!ended && open.some((t) => t.active)) g.session.lastSeen = now;
    }
    // A site still in front with no session (End was pressed, or the day rolled over) would otherwise
    // stay usable until its next navigation, which a feed or a video may never make.
    const loose = tabsWithoutSession(tabs, settings, st, now).filter((t) => !out.some(([id]) => id === t.id));
    return { kicked: out, finishing, loose };
  });
  for (const [id, url] of kicked) chrome.tabs.update(id, { url }).catch(() => {});
  for (const id of finishing) chrome.tabs.sendMessage(id, { type: "searchOnlyChanged" }).catch(() => {});
  if (kicked.length || finishing.length) notifyEnd(finishing.length > 0);
  // Not a repeat of the navigation event that `recent` dedupes, so let it through.
  for (const t of loose) { recent.delete(t.id!); check(t.id!, t.url!, true); }
  // An expired pass sends its tab to the gate like any other visit. A tab in front was just checked above,
  // and checking it twice would count two gate stops.
  const expired = Object.keys(agentTabs).filter((id) => agentTabs[id].end <= Date.now());
  if (expired.length) {
    for (const id of expired) delete agentTabs[id];
    await chrome.storage.session.set({ agentTabs });
    for (const id of expired) {
      const tab = tabs.find((t) => t.id === Number(id));
      if (tab?.url && !loose.includes(tab)) { recent.delete(tab.id!); check(tab.id!, tab.url); }
    }
  }
  updateBadge();
}

function notifyEnd(finishing: boolean) {
  chrome.notifications?.create({
    type: "basic", iconUrl: "icons/128.png", title: "Session over",
    message: finishing ? "Time's up. You can finish what's open, and the rest is search only." : "Time's up. Nice work stopping here.", priority: 0,
  });
}

async function updateBadge() {
  const settings = await loadSettings();
  const state = stateCache ?? (await stored("state")).state;
  const now = Date.now();
  if (nuclearOn(state, now)) {
    const left = Math.ceil((state!.nuclearUntil - now) / MIN);
    chrome.action.setBadgeText({ text: left > 99 ? `${Math.ceil(left / 60)}h` : `${left}m` });
    chrome.action.setBadgeBackgroundColor({ color: "#b4543a" });
    return;
  }
  const ends = settings.groups.map((gr) => state?.groups?.[gr.id]?.session?.end ?? 0).filter((e) => e > now);
  const text = ends.length ? `${Math.ceil((Math.min(...ends) - now) / MIN)}m` : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#7d6bd6" });
}

function rows(settings: Settings, st: State, now: number): SummaryRow[] {
  return settings.groups.map((group) => {
    const g = gs(st, group.id);
    return {
      group, status: status(group, g, now), usedMs: usedMs(g, now), remainingMs: remainingMs(group, g, now),
      sessionsLeft: sessionsLeft(group, g, now), session: g.session, cooldownUntil: cooldownUntil(group, g),
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
        const g = live(st, group, settings, now);
        return {
          group, now, status: status(group, g, now), usedMs: usedMs(g, now), remainingMs: remainingMs(group, g, now),
          sessionsLeft: sessionsLeft(group, g, now), cooldownUntil: cooldownUntil(group, g), attempts: g.attempts,
          dismissed: g.dismissed, pauseSec: pauseSeconds(settings, g.fullSessions), options: lengthOptions(group, g, now),
          resetAt: nextResetAt(now, settings.resetHour), replacement: settings.replacement,
          budgetMs: budgetMs(group, g), penaltyMs: g.penaltyMs || 0, borrowedMs: g.borrowedMs || 0,
          canBorrow: canBorrow(group, g, now), borrow: { ...BORROW, phrase: BORROW_PHRASE },
        };
      });
    case "start":
      if (!group) return { ok: false };
      return withState((_s, st, now) => {
        const g = live(st, group, settings, now);
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
    case "searchOnly": {
      const match = matchGroup(msg.url, settings);
      const route = match && searchRoute(msg.url, match);
      if (!match || !route) return null;
      if (sender.tab?.id !== undefined && await agentAllowed(sender.tab.id, match.id)) return null;
      return withState((_s, st, now) => {
        const g = live(st, match, settings, now);
        const stat = status(match, g, now);
        if (stat === "active") return "session" as const;
        const until = stat === "cooldown" ? cooldownUntil(match, g) : stat === "exhausted" ? nextResetAt(now, settings.resetHour) : 0;
        // A page that's being redirected shows the search page too, so it doesn't appear for a moment first.
        return { groupId: match.id, name: route.name, home: route.home, action: route.action, param: route.param, atHome: route.atHome || !!route.redirect, until };
      });
    }
    // Search-only mode skips the gate, and this is the way back to it for borrowing time.
    case "openGate": {
      const tab = sender.tab;
      if (!group || tab?.id === undefined || !tab.url) return { ok: false };
      await withState((_s, st) => { gs(st, group.id).attempts += 1; });
      await chrome.tabs.update(tab.id, { url: gateUrl(group.id, tab.url) });
      return { ok: true };
    }
    case "videoEnded": {
      const tab = sender.tab;
      const route = group && tab?.url ? searchRoute(tab.url, group) : null;
      if (!route || tab?.id === undefined) return { ok: false };
      sentHome.set(tab.id, route.home);
      await chrome.tabs.update(tab.id, { url: route.home });
      return { ok: true };
    }
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
        pending: await currentPending(settings, now), lockHours: settings.lockHours ?? 24, nuclearUntil: st.nuclearUntil,
      }));
    case "nuclear": {
      const until = await withState((_s, st, now) => startNuclear(st, settings, now, msg.minutes));
      await tick();
      return { until };
    }
    case "saveSettings": {
      const looser = loosenings(settings, msg.settings);
      if (!looser.length) {
        await chrome.storage.local.set({ settings: msg.settings });
        // Don't wait for storage.onChanged: the tick right after should already see the new rules.
        settingsCache = msg.settings;
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
      settingsCache = pending.settings;
      await chrome.storage.local.remove("pending");
      tick();
      return { ok: true };
    }
    case "borrowStart":
      if (!group) return { ok: false };
      return withState((_s, st, now) => {
        const g = live(st, group, settings, now);
        if (!canBorrow(group, g, now)) return { ok: false as const };
        if (!g.borrowStartedAt || now - g.borrowStartedAt > 15 * MIN) g.borrowStartedAt = now;
        return { ok: true as const, startedAt: g.borrowStartedAt };
      });
    case "borrow":
      if (!group) return { ok: false };
      return withState((_s, st, now) => {
        const g = live(st, group, settings, now);
        const waited = now - (g.borrowStartedAt || now) >= (BORROW.waitSec - 2) * 1000;
        if (!waited || msg.phrase !== BORROW_PHRASE || (msg.reason || "").trim().length < BORROW.minReason) return { ok: false };
        const ms = borrow(group, g, now);
        if (!ms) return { ok: false };
        g.borrowReason = msg.reason.trim().slice(0, 300);
        st.debt[group.id] = (st.debt[group.id] || 0) + ms;
        armEnd(group.id, g);
        return { ok: true };
      }).finally(updateBadge);
    case "agentProblem": {
      const tabId = sender.tab?.id;
      const match = matchGroup(msg.url, settings);
      if (tabId === undefined || !match) return { missing: true };
      // Every ask is a fresh problem with a fresh clock, so reloading never buys time.
      const problem = makeAgentProblem();
      const expiresAt = Date.now() + AGENT.answerSec * 1000;
      const { agentAsks } = await agentStore();
      agentAsks[tabId] = { groupId: match.id, problem, expiresAt };
      await chrome.storage.session.set({ agentAsks });
      return { name: match.name, ...agentText(problem), minutes: AGENT.minutes, expiresAt };
    }
    case "agentPass": {
      const tabId = sender.tab?.id;
      const match = matchGroup(msg.url, settings);
      if (tabId === undefined || !match) return { ok: false, error: "This site isn't limited" };
      const { agentTabs, agentAsks } = await agentStore();
      const ask = agentAsks[tabId];
      // One answer per problem, right or wrong.
      delete agentAsks[tabId];
      let error = "";
      if (!ask || ask.groupId !== match.id) error = "No problem for this tab";
      else if (Date.now() > ask.expiresAt + 2000) error = "Time's up";
      else if (!checkAgentAnswer(ask.problem, msg.answer)) error = "Wrong answer";
      else agentTabs[tabId] = { groupId: match.id, end: Date.now() + AGENT.minutes * MIN };
      await chrome.storage.session.set({ agentTabs, agentAsks });
      if (error) return { ok: false, error };
      chrome.alarms.create(`agent:${tabId}`, { when: agentTabs[tabId].end + 500 });
      return { ok: true };
    }
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
