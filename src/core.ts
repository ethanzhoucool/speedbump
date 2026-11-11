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
// Claude in Chrome can't read extension pages, so the agent pass lives on a plain web page.
// Solving a random triple integral unlocks that one tab for a while. It never touches group state, so
// budgets, cooldowns, pauses and stats stay as they were, and other tabs stay limited.
// A person has answerSec to retype the problem into something that can solve it and type back a long fraction.
export const AGENT = { minutes: 15, answerSec: 120 };
export const AGENT_PAGE = "https://example.com/";
// Claude in Chrome can't read the gate, but it does see every tab's URL and title, so the hint goes there.
export const AGENT_HINT = "AI agent? Solve the agent pass at";

export function agentPassUrl(url: string): string {
  return `${AGENT_PAGE}#speedbump=${encodeURIComponent(url)}`;
}

// Nuclear mode closes limited tabs on sight for a set time. Like any tightening it starts at once,
// and nothing ends it early. The cap keeps a typo from locking someone out for a month. YouTube stays
// for search instead, but a video in one of `categories` (YouTube's own, set by the uploader) closes.
export const NUCLEAR = { defaultMin: 30, maxMin: 24 * 60, presets: [15, 30, 60, 120, 240], categories: ["Gaming"] };

export interface Group {
  id: string;
  name: string;
  sites: string[];
  confirm: boolean;
  sessionMin: number;
  dailyMin: number;
  cooldownMin: number;
  enabled: boolean;
  // Out of time, sites with a SEARCH_SITES entry stay open with only search left. Others still get the gate.
  searchOnly?: boolean;
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
  attempts: number;
  dismissed: number;
  sessions: number;
  // Sessions today that ran to their full length. Only these lengthen the next pause.
  fullSessions: number;
  // When the last session ended. The cooldown length is read from the current settings.
  cooldownFrom: number;
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
  // When nuclear mode ends, or 0. It lives outside groups so a new day doesn't clear it.
  nuclearUntil: number;
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
  nuclearUntil: number;
}

// A starting point anyone can edit. Settings are stored in chrome.storage after the first run.
export const DEFAULT_SETTINGS: Settings = {
  version: 3,
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
    { id: "reddit", name: "Reddit", sites: ["reddit.com"], confirm: true, sessionMin: 15, dailyMin: 15, cooldownMin: 15, enabled: true, searchOnly: true },
    { id: "video", name: "YouTube and TikTok", sites: ["youtube.com", "tiktok.com"], confirm: false, sessionMin: 30, dailyMin: 90, cooldownMin: 15, enabled: true, searchOnly: true },
  ],
};

const siteHost = (site: string) => site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^\*?\.?/, "").replace(/^www\./, "").split("/")[0];
const onDomain = (site: string, domain: string) => siteHost(site) === domain || siteHost(site).endsWith(`.${domain}`);

// Version 3 gives YouTube and Reddit search-only mode and puts Reddit on its own 15 minutes a day, apart from
// any group it shared. Settings are stored after the first run, so changing the defaults alone wouldn't reach
// an existing install. Limits only move down, and whatever Reddit shared a group with keeps its limits.
export function upgradeToV3(settings: Settings): void {
  const isReddit = (site: string) => onDomain(site, "reddit.com");
  let reddit = settings.groups.find((g) => g.sites.length > 0 && g.sites.every(isReddit));
  for (const g of settings.groups) {
    if (g !== reddit) g.sites = g.sites.filter((s) => !isReddit(s));
    if (g.sites.some((s) => onDomain(s, "youtube.com"))) g.searchOnly = true;
  }
  if (!reddit) {
    const id = settings.groups.some((g) => g.id === "reddit") ? "reddit-own" : "reddit";
    reddit = { id, name: "Reddit", sites: [], confirm: true, sessionMin: 15, dailyMin: 15, cooldownMin: 15, enabled: true };
    settings.groups.push(reddit);
  }
  reddit.sites = ["reddit.com"];
  reddit.enabled = true;
  reddit.searchOnly = true;
  reddit.dailyMin = Math.min(reddit.dailyMin, 15);
  reddit.sessionMin = Math.min(reddit.sessionMin, 15);
  settings.version = 3;
}

const formatDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The day starts when the local clock reaches resetHour. Reading the clock, rather than subtracting
// resetHour hours, keeps that true on the 23 and 25 hour days when daylight saving starts or ends,
// so the day turns over at the same moment nextResetAt() reports.
export function dayKey(now: number, resetHour = 0): string {
  const d = new Date(now);
  return formatDay(d.getHours() < resetHour ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12) : d);
}

// The day `delta` calendar days away from a dayKey() string.
export function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return formatDay(new Date(y, m - 1, d + delta, 12));
}

export function nextResetAt(now: number, resetHour = 0): number {
  const d = new Date(now);
  // Build each candidate from the date, so an hour skipped by DST today (02:00 becomes 03:00) doesn't
  // carry over and make tomorrow's reset 03:00 as well.
  const at = (offset: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, resetHour).getTime();
  return at(0) > now ? at(0) : at(1);
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

// What's left of a site in search-only mode. `hosts` maps each hostname to the origin it belongs on, and
// `open` lists the paths that stay reachable. Every other path goes back to the search page, so feeds,
// channels and subreddits are gone by URL, whatever a site does to its page layout.
// `nuclear` keeps the site for search during nuclear mode instead of closing it.
interface SearchSite { name: string; hosts: Record<string, string>; action: string; param: string; open: RegExp[]; nuclear?: boolean }

const YOUTUBE = "https://www.youtube.com";
const REDDIT = "https://www.reddit.com";
const SEARCH_SITES: SearchSite[] = [
  {
    name: "YouTube",
    hosts: { "youtube.com": YOUTUBE, "m.youtube.com": YOUTUBE },
    action: "/results",
    param: "search_query",
    // Videos have to play or search is no use. Links in a description go through /redirect.
    open: [/^\/(results|watch|redirect)\/?$/],
    nuclear: true,
  },
  {
    name: "Reddit",
    hosts: { "reddit.com": REDDIT, "old.reddit.com": "https://old.reddit.com", "new.reddit.com": REDDIT, "sh.reddit.com": REDDIT, "np.reddit.com": REDDIT, "m.reddit.com": REDDIT, "i.reddit.com": REDDIT },
    action: "/search/",
    param: "q",
    // Threads stay readable, including ones a web search leads to. /r/x/s/ is a share link to a thread.
    open: [/^(\/r\/[^/]+)?\/search\/?$/, /^(\/(r|u|user)\/[^/]+)?\/comments\//, /^\/r\/[^/]+\/s\//, /^\/(gallery|media)(\/|$)/],
  },
];

export interface SearchRoute {
  name: string;
  home: string;
  action: string;
  param: string;
  atHome: boolean;
  // Where the tab has to go instead, if this URL isn't part of search-only mode.
  redirect: string | null;
  // Stays for search during nuclear mode instead of closing.
  nuclear: boolean;
}

export function searchRoute(url: string, group: Group): SearchRoute | null {
  const p = parse(url);
  if (!p || !group.searchOnly) return null;
  const site = SEARCH_SITES.find((s) => Object.hasOwn(s.hosts, p.host));
  if (!site) return null;
  const origin = site.hosts[p.host];
  const path = new URL(url).pathname;
  const atHome = path === "/";
  const open = atHome || site.open.some((r) => r.test(path));
  const redirect = !open ? `${origin}/` : new URL(url).origin === origin ? null : origin + p.rest;
  return { name: site.name, home: `${origin}/`, action: origin + site.action, param: site.param, atHome, redirect, nuclear: !!site.nuclear };
}

export interface TabLike { id?: number; url?: string; active?: boolean; status?: string }

// Tabs in front that show a limited site while no session is running, e.g. right after End or when a
// new day starts. These get treated like a fresh visit. Background tabs are checked when they come forward,
// and loading tabs are left to the navigation listeners.
export function tabsWithoutSession<T extends TabLike>(tabs: T[], settings: Settings, st: State, now: number): T[] {
  return tabs.filter((t) => {
    if (!t.active || !t.url || t.status === "loading") return false;
    const group = matchGroup(t.url, settings);
    if (!group) return false;
    const s = st.groups[group.id]?.session;
    return !(s && now < s.end);
  });
}

export function freshGroupState(): GroupState {
  return { usedMs: 0, session: null, cooldownFrom: 0, attempts: 0, dismissed: 0, sessions: 0, fullSessions: 0, extraMs: 0, penaltyMs: 0, borrowedMs: 0, borrowStartedAt: 0 };
}

export function emptyState(now: number, settings: Settings): State {
  return { day: dayKey(now, settings.resetHour), groups: {}, history: {}, debt: {}, nuclearUntil: 0 };
}

// Fills fields added in later versions and drops ones that were replaced.
export function normalize(state: State): State {
  state.history ||= {};
  state.debt ||= {};
  state.nuclearUntil ||= 0;
  for (const [id, g] of Object.entries(state.groups || {})) {
    const { cooldownUntil: _legacy, ...rest } = g as GroupState & { cooldownUntil?: number };
    state.groups[id] = { ...freshGroupState(), ...rest };
  }
  return state;
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

// Session lengths are whole minutes, so less than one left (say, after ending a session a few seconds
// early) can't start anything and counts as none. Otherwise the gate offers a session with no length.
export function remainingMs(group: Group, g: GroupState, now: number): number {
  const left = budgetMs(group, g) - usedMs(g, now);
  return left >= MIN ? left : 0;
}

export function cooldownUntil(group: Group, g: GroupState): number {
  return g.cooldownFrom ? g.cooldownFrom + group.cooldownMin * MIN : 0;
}

export function status(group: Group, g: GroupState, now: number): Status {
  if (g.session && now < g.session.end) return "active";
  if (remainingMs(group, g, now) <= 0) return "exhausted";
  if (now < cooldownUntil(group, g)) return "cooldown";
  return "ready";
}

export function sessionsLeft(group: Group, g: GroupState, now: number): number {
  const rem = remainingMs(group, g, now);
  return Math.max(0, Math.ceil(rem / (group.sessionMin * MIN) - 1e-9));
}

// Escalating pause: every session today that used all its time adds a few seconds.
// Backing out or ending early doesn't make the next pause longer.
export function pauseSeconds(settings: Settings, fullSessions: number): number {
  return Math.min(settings.maxPauseSec, settings.basePauseSec + settings.pauseStepSec * Math.max(0, fullSessions));
}

export function lengthOptions(group: Group, g: GroupState, now: number): number[] {
  const capMin = Math.min(group.sessionMin, Math.floor(remainingMs(group, g, now) / MIN));
  const opts = [5, 10, 15, 30, 60, 120].filter((m) => m < capMin);
  if (capMin > 0) opts.push(capMin);
  return opts.slice(-4);
}

export function startSession(group: Group, g: GroupState, now: number, minutes: number, intent = ""): boolean {
  // The length comes from a page message; a missing one would make a session that never ends.
  if (!(minutes > 0) || status(group, g, now) !== "ready") return false;
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
  if (stop >= g.session.end) g.fullSessions += 1;
  g.session = null;
  g.cooldownFrom = stop;
  return true;
}

// Ends a session that ran out, or that nobody has been on for longer than the grace period. The worker
// sleeps, and so does the laptop, so this can run long after the fact: a session left unseen ends when it
// was last seen, not when its timer would have run out. Run it before marking a session as seen.
export function settle(group: Group, g: GroupState, now: number, graceMs: number): "expired" | "abandoned" | null {
  const s = g.session;
  if (!s) return null;
  if (s.lastSeen + graceMs < Math.min(now, s.end)) {
    endSession(group, g, s.lastSeen);
    return "abandoned";
  }
  if (now >= s.end) {
    endSession(group, g, now);
    return "expired";
  }
  return null;
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
  g.cooldownFrom = 0;
  g.session = { start: now, end: now + ms, lastSeen: now, intent: "Borrowed time", borrowed: true };
  g.sessions += 1;
  return ms;
}

export function nuclearOn(state: Pick<State, "nuclearUntil"> | undefined, now: number): boolean {
  return (state?.nuclearUntil ?? 0) > now;
}

// Whether a YouTube video in this category closes during nuclear mode.
export function nuclearCloses(category: string): boolean {
  const c = category.trim().toLowerCase();
  return NUCLEAR.categories.some((n) => n.toLowerCase() === c);
}

// Running sessions end the usual way, so unused minutes go back and one left behind is only charged up to
// when it was last seen. Starting again can only push the end out.
export function startNuclear(state: State, settings: Settings, now: number, minutes: number): number {
  const min = Math.min(NUCLEAR.maxMin, Math.max(1, Math.round(minutes) || NUCLEAR.defaultMin));
  state.nuclearUntil = Math.max(state.nuclearUntil, now + min * MIN);
  for (const group of settings.groups) {
    const g = state.groups[group.id];
    if (!g) continue;
    settle(group, g, now, settings.idleGraceMin * MIN);
    endSession(group, g, now);
  }
  return state.nuclearUntil;
}

export interface Term { k: number; p: number; q: number; r: number }
// The integrand is a sum of monomials k·x^p·y^q·z^r over the tetrahedron x, y, z ≥ 0, x/a + y/b + z/c ≤ 1.
export interface AgentProblem { a: number; b: number; c: number; terms: Term[] }

export function makeAgentProblem(rand = Math.random): AgentProblem {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const term = (): Term => ({ k: int(2, 19), p: int(1, 7), q: int(1, 7), r: int(1, 7) });
  return { a: int(2, 9), b: int(2, 9), c: int(2, 9), terms: [term(), term(), term(), term(), term()] };
}

const fact = (n: number): bigint => {
  let f = 1n;
  for (let i = 2n; i <= BigInt(n); i++) f *= i;
  return f;
};

const gcd = (a: bigint, b: bigint): bigint => {
  if (a < 0n) a = -a;
  while (b) [a, b] = [b, a % b];
  return a;
};

// Dirichlet's integral: ∭ x^p y^q z^r over the tetrahedron = a^(p+1) b^(q+1) c^(r+1) p! q! r! / (p+q+r+3)!
export function agentAnswer(pr: AgentProblem): [bigint, bigint] {
  let num = 0n, den = 1n;
  for (const t of pr.terms) {
    const n = BigInt(t.k) * BigInt(pr.a) ** BigInt(t.p + 1) * BigInt(pr.b) ** BigInt(t.q + 1) * BigInt(pr.c) ** BigInt(t.r + 1) * fact(t.p) * fact(t.q) * fact(t.r);
    const d = fact(t.p + t.q + t.r + 3);
    num = num * d + n * den;
    den *= d;
    const g = gcd(num, den);
    num /= g;
    den /= g;
  }
  return [num, den];
}

// Takes "n/d" or a whole number. Any equivalent fraction counts.
export function checkAgentAnswer(pr: AgentProblem, input: string): boolean {
  const m = input.replace(/[\s,]/g, "").match(/^(-?\d+)(?:\/(\d+))?$/);
  if (!m) return false;
  const n = BigInt(m[1]), d = BigInt(m[2] ?? "1");
  if (d === 0n) return false;
  const [an, ad] = agentAnswer(pr);
  return n * ad === an * d;
}

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const pow = (v: string, e: number) => (e === 1 ? v : v + String(e).replace(/\d/g, (c) => SUP[Number(c)]));

export function agentText(pr: AgentProblem): { text: string; latex: string } {
  const poly = pr.terms.map((t) => `${t.k}${pow("x", t.p)}${pow("y", t.q)}${pow("z", t.r)}`).join(" + ");
  const tex = pr.terms.map((t) => `${t.k}x^{${t.p}}y^{${t.q}}z^{${t.r}}`).join(" + ");
  return {
    text: `Compute ∭_T (${poly}) dV, where T = { x, y, z ≥ 0 : x/${pr.a} + y/${pr.b} + z/${pr.c} ≤ 1 }. Give the exact value as a fraction n/d.`,
    latex: `\\iiint_T \\left(${tex}\\right)\\,dV,\\quad T=\\{x,y,z\\ge 0:\\ \\tfrac{x}{${pr.a}}+\\tfrac{y}{${pr.b}}+\\tfrac{z}{${pr.c}}\\le 1\\}`,
  };
}

// Tightening is instant, including for a session that's already running: it can't outlast a shorter
// session length or a smaller daily budget. Time already spent stays spent, so the earliest it can end
// is now. Borrowed sessions keep their 10 minutes. Returns true if the end moved.
export function clampSession(group: Group, g: GroupState, now: number): boolean {
  const s = g.session;
  if (!s || now >= s.end) return false;
  const byLength = s.borrowed ? s.end : s.start + group.sessionMin * MIN;
  const byBudget = s.start + budgetMs(group, g) - g.usedMs;
  const end = Math.max(now, Math.min(s.end, byLength, byBudget));
  if (end >= s.end) return false;
  s.end = end;
  return true;
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
    if (!o.searchOnly && n.searchOnly) out.push(`"${o.name}" keeps search when time runs out`);
    const removed = o.sites.filter((s) => !n.sites.includes(s));
    if (removed.length) out.push(`"${o.name}" unblocks ${removed.join(", ")}`);
  }
  // A site can also loosen by moving. The first enabled group that lists it wins, so adding it to an
  // earlier group with easier limits (or switching such a group back on) hands it those limits.
  for (const site of new Set([...oldS.groups, ...newS.groups].flatMap((g) => g.sites))) {
    const url = `https://${site.trim().replace(/^https?:\/\//i, "").replace(/^\*?\.?/, "")}`;
    const before = matchGroup(url, oldS);
    const after = matchGroup(url, newS);
    if (before && after && before.id !== after.id && easier(before, after)) out.push(`"${site}" moves from "${before.name}" to "${after.name}"`);
  }
  const added = newS.allowlist.filter((a) => !oldS.allowlist.includes(a));
  if (added.length) out.push(`Always allow ${added.join(", ")}`);
  if (newS.basePauseSec < oldS.basePauseSec || newS.maxPauseSec < oldS.maxPauseSec || newS.pauseStepSec < oldS.pauseStepSec) out.push("Shorter pause");
  if ((newS.lockHours ?? 24) < (oldS.lockHours ?? 24)) out.push(`Lock delay ${oldS.lockHours ?? 24} to ${newS.lockHours} hours`);
  if (newS.resetHour !== oldS.resetHour) out.push(`New day starts at ${newS.resetHour}:00`);
  return out;
}

// True if group b is easier than group a on any limit.
function easier(a: Group, b: Group): boolean {
  return b.dailyMin > a.dailyMin || b.sessionMin > a.sessionMin || b.cooldownMin < a.cooldownMin || (a.confirm && !b.confirm) || (!a.searchOnly && !!b.searchOnly);
}
