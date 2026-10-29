// Pure logic shared by the service worker, the pages and the node tests.
// No chrome.* calls in here.

export const MIN = 60_000;
export const HOUR = 60 * MIN;

// Extra time is possible, just slow: once per group per day, paid back from tomorrow.
export const BORROW = { minutes: 10, waitSec: 90, minReason: 40 };
export const BORROW_PHRASE = "I am taking this time from tomorrow";
// Once a looser change is ready, it has to be confirmed inside this window or it lapses.
export const CONFIRM_WINDOW_HOURS = 24;
export const CHALLENGE = "I want looser limits and I will still want them tomorrow";

export interface Group {
  id: string;
  name: string;
  sites: string[];
  confirm: boolean;
  sessionMin: number;
  dailyMin: number;
  cooldownMin: number;
  enabled: boolean;
}

export interface Settings {
  version: number;
  resetHour: number;
  basePauseSec: number;
  pauseStepSec: number;
  maxPauseSec: number;
  idleGraceMin: number;
  lockHours: number;
  replacement: { label: string; url: string };
  allowlist: string[];
  groups: Group[];
}

export interface Session {
  start: number;
  end: number;
  lastSeen: number;
  intent: string;
  borrowed?: boolean;
}

export interface GroupState {
  usedMs: number;
  session: Session | null;
  cooldownUntil: number;
  attempts: number;
  dismissed: number;
  sessions: number;
  extraMs: number;
  penaltyMs: number;
  borrowedMs: number;
  borrowStartedAt: number;
  borrowReason?: string;
}

export type DaySnapshot = Pick<GroupState, "usedMs" | "attempts" | "dismissed" | "sessions" | "borrowedMs">;

export interface State {
  day: string;
  groups: Record<string, GroupState>;
  history: Record<string, Record<string, DaySnapshot>>;
  // Minutes borrowed today, taken off tomorrow's budget.
  debt: Record<string, number>;
}

export type Status = "ready" | "active" | "cooldown" | "exhausted";

export interface Pending {
  settings: Settings;
  base: string;
  changes: string[];
  requestedAt: number;
  readyAt: number;
  expiresAt: number;
}

export type PendingStatus = "waiting" | "ready" | "expired" | "stale";

// What the pages get back from the service worker.
export interface GateInfo {
  group: Group;
  now: number;
  status: Status;
  usedMs: number;
  remainingMs: number;
  sessionsLeft: number;
  cooldownUntil: number;
  attempts: number;
  dismissed: number;
  pauseSec: number;
  options: number[];
  resetAt: number;
  replacement: Settings["replacement"];
  budgetMs: number;
  penaltyMs: number;
  borrowedMs: number;
  canBorrow: boolean;
  borrow: typeof BORROW & { phrase: string };
}

export interface SummaryRow {
  group: Group;
  status: Status;
  usedMs: number;
  remainingMs: number;
  sessionsLeft: number;
  session: Session | null;
  cooldownUntil: number;
  attempts: number;
  dismissed: number;
  sessions: number;
  budgetMs: number;
  penaltyMs: number;
  borrowedMs: number;
}

export type PendingView = (Pending & { status: "waiting" | "ready" }) | { status: "expired" | "stale"; changes: string[] };

export interface Summary {
  now: number;
  rows: SummaryRow[];
  history: State["history"];
  day: string;
  debt: State["debt"];
  pending: PendingView | null;
  lockHours: number;
}

// A starting point anyone can edit. Settings are stored in chrome.storage after the first run.
export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  resetHour: 0,
  basePauseSec: 5,
  pauseStepSec: 5,
  maxPauseSec: 30,
  idleGraceMin: 2,
  lockHours: 24,
  replacement: { label: "Do something else", url: "" },
  allowlist: ["music.youtube.com"],
  groups: [
    { id: "x", name: "X", sites: ["x.com", "twitter.com"], confirm: true, sessionMin: 15, dailyMin: 45, cooldownMin: 15, enabled: true },
    { id: "instagram", name: "Instagram", sites: ["instagram.com"], confirm: true, sessionMin: 15, dailyMin: 45, cooldownMin: 15, enabled: true },
    { id: "facebook", name: "Facebook", sites: ["facebook.com"], confirm: true, sessionMin: 15, dailyMin: 45, cooldownMin: 15, enabled: true },
    { id: "reddit", name: "Reddit", sites: ["reddit.com"], confirm: true, sessionMin: 15, dailyMin: 45, cooldownMin: 15, enabled: true },
    { id: "video", name: "YouTube and TikTok", sites: ["youtube.com", "tiktok.com"], confirm: false, sessionMin: 30, dailyMin: 90, cooldownMin: 15, enabled: true },
  ],
};

export function dayKey(now: number, resetHour = 0): string {
  const d = new Date(now - resetHour * HOUR);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function nextResetAt(now: number, resetHour = 0): number {
  const d = new Date(now);
  d.setHours(resetHour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

interface Parsed { host: string; rest: string }

function parse(url: string): Parsed | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return { host: u.hostname.replace(/^www\./, "").toLowerCase(), rest: u.pathname + u.search };
  } catch {
    return null;
  }
}

// "x.com" matches x.com and any subdomain; "reddit.com/r/news" also requires the path prefix.
function siteMatches(site: string, p: Parsed): boolean {
  const s = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^\*?\.?/, "").replace(/^www\./, "");
  if (!s) return false;
  const slash = s.indexOf("/");
  const host = slash === -1 ? s : s.slice(0, slash);
  const path = slash === -1 ? "" : s.slice(slash);
  const hostOk = p.host === host || p.host.endsWith("." + host);
  return hostOk && (!path || p.rest.startsWith(path));
}

export function isAllowed(url: string, settings: Settings): boolean {
  const p = parse(url);
  return !!p && settings.allowlist.some((a) => siteMatches(a, p));
}

export function matchGroup(url: string, settings: Settings): Group | null {
  const p = parse(url);
  if (!p || isAllowed(url, settings)) return null;
  return settings.groups.find((g) => g.enabled && g.sites.some((s) => siteMatches(s, p))) || null;
}

export function freshGroupState(): GroupState {
  return { usedMs: 0, session: null, cooldownUntil: 0, attempts: 0, dismissed: 0, sessions: 0, extraMs: 0, penaltyMs: 0, borrowedMs: 0, borrowStartedAt: 0 };
}

export function emptyState(now: number, settings: Settings): State {
  return { day: dayKey(now, settings.resetHour), groups: {}, history: {}, debt: {} };
}

export function gs(state: State, id: string): GroupState {
  return (state.groups[id] ||= freshGroupState());
}

// Moves yesterday into history. Returns true if the day changed.
export function rollover(state: State, now: number, settings: Settings): boolean {
  const today = dayKey(now, settings.resetHour);
  if (state.day === today) return false;
  const snap: Record<string, DaySnapshot> = {};
  for (const [id, g] of Object.entries(state.groups)) {
    const live = g.session ? Math.min(now, g.session.end) - g.session.start : 0;
    snap[id] = { usedMs: g.usedMs + live, attempts: g.attempts, dismissed: g.dismissed, sessions: g.sessions, borrowedMs: g.borrowedMs || 0 };
  }
  state.history[state.day] = snap;
  const keep = Object.keys(state.history).sort().slice(-30);
  state.history = Object.fromEntries(keep.map((k) => [k, state.history[k]]));
  state.day = today;
  state.groups = {};
  // Yesterday's borrowed minutes come out of today's budget.
  for (const [id, ms] of Object.entries(state.debt || {})) state.groups[id] = { ...freshGroupState(), penaltyMs: ms };
  state.debt = {};
  return true;
}

export function usedMs(g: GroupState, now: number): number {
  return g.usedMs + (g.session ? Math.max(0, Math.min(now, g.session.end) - g.session.start) : 0);
}

// Today's budget: the daily limit, plus borrowed time, minus what was borrowed yesterday.
export function budgetMs(group: Group, g: GroupState): number {
  return Math.max(0, group.dailyMin * MIN + (g.extraMs || 0) - (g.penaltyMs || 0));
}

export function remainingMs(group: Group, g: GroupState, now: number): number {
  return Math.max(0, budgetMs(group, g) - usedMs(g, now));
}

export function status(group: Group, g: GroupState, now: number): Status {
  if (g.session && now < g.session.end) return "active";
  if (remainingMs(group, g, now) <= 0) return "exhausted";
  if (now < g.cooldownUntil) return "cooldown";
  return "ready";
}

export function sessionsLeft(group: Group, g: GroupState, now: number): number {
  const rem = remainingMs(group, g, now);
  return Math.ceil(rem / (group.sessionMin * MIN) - 1e-9);
}

// Escalating pause: every attempt today adds a few seconds.
export function pauseSeconds(settings: Settings, attempts: number): number {
  return Math.min(settings.maxPauseSec, settings.basePauseSec + settings.pauseStepSec * Math.max(0, attempts - 1));
}

export function lengthOptions(group: Group, g: GroupState, now: number): number[] {
  const capMin = Math.min(group.sessionMin, Math.floor(remainingMs(group, g, now) / MIN));
  const opts = [5, 10, 15, 30, 60, 120].filter((m) => m < capMin);
  if (capMin > 0) opts.push(capMin);
  return opts.slice(-4);
}

export function startSession(group: Group, g: GroupState, now: number, minutes: number, intent = ""): boolean {
  if (status(group, g, now) !== "ready") return false;
  const planned = Math.min(minutes, group.sessionMin) * MIN;
  const ms = Math.min(planned, remainingMs(group, g, now));
  if (ms <= 0) return false;
  g.session = { start: now, end: now + ms, lastSeen: now, intent: intent.slice(0, 80) };
  g.sessions += 1;
  return true;
}

// Ends a session early or on expiry. Unused minutes go back to the daily pool; the cooldown still applies.
export function endSession(group: Group, g: GroupState, now: number): boolean {
  if (!g.session) return false;
  const stop = Math.min(now, g.session.end);
  g.usedMs += Math.max(0, stop - g.session.start);
  g.session = null;
  if (remainingMs(group, g, stop) > 0) g.cooldownUntil = stop + group.cooldownMin * MIN;
  return true;
}

export function canBorrow(group: Group, g: GroupState, now: number): boolean {
  const s = status(group, g, now);
  return (s === "cooldown" || s === "exhausted") && !g.borrowedMs;
}

// Skips the cooldown (or the empty budget) with a short session, charged to tomorrow.
export function borrow(group: Group, g: GroupState, now: number): number {
  if (!canBorrow(group, g, now)) return 0;
  const ms = BORROW.minutes * MIN;
  g.extraMs = (g.extraMs || 0) + ms;
  g.borrowedMs = ms;
  g.cooldownUntil = 0;
  g.session = { start: now, end: now + ms, lastSeen: now, intent: "Borrowed time", borrowed: true };
  g.sessions += 1;
  return ms;
}

// Key order can change on a storage round trip, so compare settings with sorted keys.
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

// A looser change waits lockHours, then has to be confirmed within CONFIRM_WINDOW_HOURS.
export function requestChange(current: Settings, next: Settings, now: number): Pending {
  const readyAt = now + (current.lockHours ?? 24) * HOUR;
  return { settings: next, base: stable(current), changes: loosenings(current, next), requestedAt: now, readyAt, expiresAt: readyAt + CONFIRM_WINDOW_HOURS * HOUR };
}

// "stale" means the rules changed after the request was made.
export function pendingStatus(p: Pending | null | undefined, current: Settings, now: number): PendingStatus | null {
  if (!p) return null;
  if (p.base !== stable(current)) return "stale";
  if (now >= p.expiresAt) return "expired";
  return now >= p.readyAt ? "ready" : "waiting";
}

// Which changes make the rules looser (these wait out the lock).
export function loosenings(oldS: Settings, newS: Settings): string[] {
  const out: string[] = [];
  const byId = Object.fromEntries(newS.groups.map((g) => [g.id, g]));
  for (const o of oldS.groups) {
    const n = byId[o.id];
    if (!n) { out.push(`Delete "${o.name}"`); continue; }
    if (o.enabled && !n.enabled) out.push(`Turn off "${o.name}"`);
    if (n.dailyMin > o.dailyMin) out.push(`"${o.name}" daily limit ${o.dailyMin} to ${n.dailyMin} min`);
    if (n.sessionMin > o.sessionMin) out.push(`"${o.name}" session ${o.sessionMin} to ${n.sessionMin} min`);
    if (n.cooldownMin < o.cooldownMin) out.push(`"${o.name}" cooldown ${o.cooldownMin} to ${n.cooldownMin} min`);
    if (o.confirm && !n.confirm) out.push(`"${o.name}" stops asking first`);
    const removed = o.sites.filter((s) => !n.sites.includes(s));
    if (removed.length) out.push(`"${o.name}" unblocks ${removed.join(", ")}`);
  }
  const added = newS.allowlist.filter((a) => !oldS.allowlist.includes(a));
  if (added.length) out.push(`Always allow ${added.join(", ")}`);
  if (newS.basePauseSec < oldS.basePauseSec || newS.maxPauseSec < oldS.maxPauseSec || newS.pauseStepSec < oldS.pauseStepSec) out.push("Shorter pause");
  if ((newS.lockHours ?? 24) < (oldS.lockHours ?? 24)) out.push(`Lock delay ${oldS.lockHours ?? 24} to ${newS.lockHours} hours`);
  if (newS.resetHour !== oldS.resetHour) out.push(`New day starts at ${newS.resetHour}:00`);
  return out;
}
