import { DEFAULT_SETTINGS, CHALLENGE, MIN, HOUR, loosenings } from "./core.ts";
import type { Group, Settings, Summary } from "./core.ts";
import { send } from "./messages.ts";
import { $, esc, favicon, blockPaste } from "./dom.ts";

const lines = (v: string) => v.split(/\n+/).map((s) => s.trim()).filter(Boolean);
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const siteIcon = (site: string) => favicon(`https://${site.split("/")[0]}`);
const span = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / MIN));
  const h = Math.floor(total / 60), m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};
const cleanSite = (v: string) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
const siteList = (v: string) => [...new Set(v.split(/[\s,]+/).map(cleanSite).filter(Boolean))];

let saved: Settings;
let draft: Settings;
let summary: Summary | undefined;
let dialogMode: "request" | "apply" = "request";

async function init() {
  const { settings } = (await chrome.storage.local.get("settings")) as { settings?: Settings };
  saved = settings || clone(DEFAULT_SETTINGS);
  saved.lockHours ??= 24;
  draft = clone(saved);
  renderGroups();
  renderGeneral();
  await refresh();
  dirty();
}

async function refresh() {
  summary = await send({ type: "summary" });
  $("lock").textContent = `Stricter changes save now. Looser ones wait ${saved.lockHours} h, then need a second yes.`;
  renderNotices(summary);
  renderStats(summary);
}

// Pending request, lapsed request, and the incognito loophole.
async function renderNotices(data: Summary) {
  const out: string[] = [];
  const p = data.pending;
  const now = Date.now();
  const list = (c: string[]) => `<span class="m">${c.map(esc).join("; ")}</span>`;
  if (p?.status === "waiting") {
    out.push(`<div class="notice"><p>Requested, confirm in ${span(p.readyAt - now)}: ${list(p.changes)}</p>
      <div class="acts"><button class="link" data-cancel>Cancel</button></div></div>`);
  } else if (p?.status === "ready") {
    out.push(`<div class="notice ready"><p>Still want this? Lapses in ${span(p.expiresAt - now)}: ${list(p.changes)}</p>
      <div class="acts"><button class="link" data-cancel>Drop it</button><button class="link go" data-apply>Confirm</button></div></div>`);
  } else if (p?.status === "expired" || p?.status === "stale") {
    out.push(`<div class="notice"><p class="m">${p.status === "expired" ? "Your last request lapsed, so nothing changed." : "Your last request was cancelled because your rules changed."}</p></div>`);
  }
  if ((await chrome.extension.isAllowedIncognitoAccess?.()) === false) {
    out.push(`<div class="notice"><p>Incognito skips every limit. <span class="m">Turn on "Allow in Incognito".</span></p>
      <div class="acts"><button class="link" data-incognito>Open</button></div></div>`);
  }
  const box = $("notices");
  box.innerHTML = out.join("");
  box.querySelector("[data-cancel]")?.addEventListener("click", async () => { await send({ type: "cancelPending" }); refresh(); });
  box.querySelector("[data-apply]")?.addEventListener("click", () => openChallenge("apply", p?.changes ?? []));
  box.querySelector("[data-incognito]")?.addEventListener("click", () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
}

function num(k: keyof Group, label: string, v: number, min: number) {
  return `<td class="n" data-l="${label}"><input type="number" min="${min}" data-k="${k}" value="${v}" aria-label="${label}"></td>`;
}

function groupRow(g: Group, i: number) {
  return `<tr class="${g.enabled ? "" : "off"}" data-i="${i}">
    <td class="name"><img src="${g.sites[0] ? siteIcon(g.sites[0]) : "icons/16.png"}" alt=""><input type="text" data-k="name" value="${esc(g.name)}" aria-label="Group name"></td>
    <td class="sites"><input type="text" data-k="sites" value="${esc(g.sites.join(", "))}" aria-label="Sites" placeholder="example.com"></td>
    ${num("sessionMin", "Session", g.sessionMin, 1)}
    ${num("dailyMin", "Per day", g.dailyMin, 0)}
    ${num("cooldownMin", "Cooldown", g.cooldownMin, 0)}
    <td class="c"><input type="checkbox" data-k="confirm" ${g.confirm ? "checked" : ""} aria-label="Ask first"></td>
    <td class="c keep"><input type="checkbox" data-k="enabled" ${g.enabled ? "checked" : ""} aria-label="On"></td>
    <td class="c"><button class="x" data-del aria-label="Delete ${esc(g.name)}">×</button></td>
  </tr>`;
}

function renderGroups() {
  const body = $("groups");
  body.innerHTML = draft.groups.map(groupRow).join("");
  body.querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
    const g = draft.groups[Number(row.dataset.i)];
    row.querySelectorAll<HTMLInputElement>("[data-k]").forEach((el) => el.addEventListener("input", () => {
      const k = el.dataset.k as keyof Group;
      if (k === "confirm" || k === "enabled") g[k] = el.checked;
      else if (k === "sessionMin" || k === "dailyMin" || k === "cooldownMin") g[k] = Math.max(Number(el.min) || 0, Math.round(Number(el.value) || 0));
      else if (k === "sites") g.sites = siteList(el.value);
      else if (k === "name") g.name = el.value;
      if (k === "enabled") row.classList.toggle("off", !g.enabled);
      dirty();
    }));
    row.querySelector<HTMLInputElement>("[data-k=sites]")!.addEventListener("blur", (e) => { (e.target as HTMLInputElement).value = g.sites.join(", "); });
    row.querySelector("[data-del]")!.addEventListener("click", () => {
      draft.groups.splice(Number(row.dataset.i), 1);
      renderGroups();
      dirty();
    });
  });
}

$("add").addEventListener("click", () => {
  draft.groups.push({ id: `g${Date.now().toString(36)}`, name: "New group", sites: [], confirm: true, sessionMin: 15, dailyMin: 45, cooldownMin: 15, enabled: true });
  renderGroups();
  dirty();
  $("groups").querySelector<HTMLInputElement>("tr:last-child [data-k=sites]")?.focus();
});

type NumericKey = "basePauseSec" | "pauseStepSec" | "maxPauseSec" | "resetHour" | "lockHours";
const general: [string, NumericKey][] = [["basePause", "basePauseSec"], ["stepPause", "pauseStepSec"], ["maxPause", "maxPauseSec"], ["resetHour", "resetHour"], ["lockHours", "lockHours"]];

function renderGeneral() {
  for (const [id, key] of general) $<HTMLInputElement>(id).value = String(draft[key]);
  $<HTMLInputElement>("repLabel").value = draft.replacement?.label || "";
  $<HTMLInputElement>("repUrl").value = draft.replacement?.url || "";
  $<HTMLTextAreaElement>("allow").value = draft.allowlist.join("\n");
}

for (const [id, key] of general) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener("input", () => { draft[key] = Math.max(Number(el.min) || 0, Math.round(Number(el.value) || 0)); dirty(); });
}
$<HTMLInputElement>("repLabel").addEventListener("input", (e) => { draft.replacement = { ...draft.replacement, label: (e.target as HTMLInputElement).value }; dirty(); });
$<HTMLInputElement>("repUrl").addEventListener("input", (e) => { draft.replacement = { ...draft.replacement, url: (e.target as HTMLInputElement).value.trim() }; dirty(); });
$<HTMLTextAreaElement>("allow").addEventListener("input", (e) => { draft.allowlist = lines((e.target as HTMLTextAreaElement).value); dirty(); });

function dirty() {
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const looser = loosenings(saved, draft);
  const byId = Object.fromEntries(saved.groups.map((g) => [g.id, g]));
  $("groups").querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
    const n = draft.groups[Number(row.dataset.i)];
    const o = byId[n.id];
    row.classList.toggle("looser", !!o && loosenings({ ...saved, groups: [o] }, { ...saved, groups: [n] }).length > 0);
  });
  $("saveBar").classList.toggle("show", changed);
  $("saveBar").classList.toggle("looser", looser.length > 0);
  const live = summary?.pending?.status === "waiting" || summary?.pending?.status === "ready";
  $("saveMsg").textContent = looser.length
    ? `${looser.length} looser, waits ${saved.lockHours} h`
    : live ? "Saving cancels your request" : "Stricter, saves now";
  $("save").textContent = looser.length ? "Request" : "Save";
}

$("revert").addEventListener("click", () => { draft = clone(saved); renderGroups(); renderGeneral(); dirty(); });

async function save(challenge?: string) {
  const res = await send({ type: "saveSettings", settings: draft, challenge });
  if ("needsChallenge" in res) return openChallenge("request", res.needsChallenge);
  if ("pending" in res) {
    draft = clone(saved);
    renderGroups();
    renderGeneral();
  } else if (res.ok) {
    saved = clone(draft);
  }
  await refresh();
  dirty();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$("save").addEventListener("click", () => save());

const dialog = $<HTMLDialogElement>("challenge");
const phraseInput = $<HTMLInputElement>("phraseInput");
const confirmBtn = $<HTMLButtonElement>("confirm");

function openChallenge(mode: "request" | "apply", changes: string[]) {
  dialogMode = mode;
  $("dTitle").textContent = mode === "apply" ? "Confirm your request" : "This loosens your limits";
  $("dLede").textContent = mode === "apply"
    ? "If the urge has passed, keep your limits."
    : `Nothing changes now. In ${saved.lockHours} h you confirm it again, or it lapses.`;
  $("changes").innerHTML = changes.map((c) => `<li>${esc(c)}</li>`).join("");
  $("phrase").textContent = CHALLENGE;
  phraseInput.value = "";
  confirmBtn.textContent = mode === "apply" ? "Apply" : "Request";
  typed();
  dialog.showModal();
  phraseInput.focus();
}

function typed() {
  const v = phraseInput.value;
  confirmBtn.disabled = v !== CHALLENGE;
  $("typedCount").textContent = `${v.length}/${CHALLENGE.length}`;
}

blockPaste(phraseInput);
phraseInput.addEventListener("input", typed);
$("cancel").addEventListener("click", () => dialog.close());
confirmBtn.addEventListener("click", async () => {
  const challenge = phraseInput.value;
  dialog.close();
  if (dialogMode === "request") return save(challenge);
  const res = await send({ type: "applyPending", challenge });
  if (res?.ok) {
    const { settings } = (await chrome.storage.local.get("settings")) as { settings: Settings };
    saved = settings;
    draft = clone(saved);
    renderGroups();
    renderGeneral();
  }
  await refresh();
  dirty();
});

function renderStats(data: Summary) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000 - (saved.resetHour || 0) * HOUR);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const isToday = key === data.day;
    const vals = isToday ? data.rows : Object.values(data.history[key] || {});
    days.push({
      label: isToday ? "Today" : d.toLocaleDateString([], { weekday: "short" }),
      // Today's rows already include any live session.
      min: Math.round(vals.reduce((a, v) => a + (v.usedMs || 0), 0) / MIN),
      attempts: vals.reduce((a, v) => a + (v.attempts || 0), 0),
      dismissed: vals.reduce((a, v) => a + (v.dismissed || 0), 0),
      borrowed: vals.some((v) => v.borrowedMs > 0),
      isToday,
    });
  }
  // Days in a row without borrowing, counting back from today.
  let streak = data.rows.some((r) => r.borrowedMs > 0) ? 0 : 1;
  if (streak) for (const k of Object.keys(data.history).sort().reverse()) { if (Object.values(data.history[k]).some((v) => v.borrowedMs > 0)) break; streak += 1; }
  const week = days.reduce((a, d) => a + d.min, 0);
  const backed = days.reduce((a, d) => a + d.dismissed, 0);
  const stops = days.reduce((a, d) => a + d.attempts, 0);
  $("stats").innerHTML = `<span><b>${days[6].min}m</b> today</span><span><b>${week}m</b> this week</span><span><b>${backed}</b> of ${stops} gate stops backed out</span><span><b>${streak}</b> day${streak === 1 ? "" : "s"} without borrowing</span>`;
  const max = Math.max(30, ...days.map((d) => d.min));
  $("week").innerHTML = days.map((d) => `<span class="${d.isToday ? "today" : ""} ${d.borrowed ? "borrowed" : ""}" style="height:${(d.min / max) * 100}%" title="${d.min} min${d.borrowed ? ", borrowed time" : ""}"></span>`).join("");
  $("days").innerHTML = days.map((d) => `<span>${d.label}</span>`).join("");
}

init();
setInterval(() => { if (!dialog.open) refresh().then(dirty); }, 30_000);
