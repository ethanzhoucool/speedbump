import { MIN } from "./core.ts";
import type { GateInfo } from "./core.ts";
import { send as rawSend } from "./messages.ts";
import type { Message, Replies } from "./messages.ts";
import { $, esc, favicon, blockPaste } from "./dom.ts";

type GroupMessage = Extract<Message, { groupId: string }>;

const params = new URLSearchParams(location.search);
const groupId = params.get("g") || "";
const target = params.get("u") || "";
const app = $("app");
// Every gate message is about this page's group, so fill groupId in.
function send<T extends GroupMessage["type"]>(msg: Omit<Extract<GroupMessage, { type: T }>, "groupId"> & { type: T }): Promise<Replies[T]> {
  return rawSend({ ...msg, groupId } as GroupMessage) as Promise<Replies[T]>;
}

let timers: ReturnType<typeof setInterval>[] = [];
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };

const mins = (ms: number) => Math.round(ms / MIN);
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};
const timeOfDay = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

let host = "";
try { host = new URL(target).hostname.replace(/^www\./, ""); } catch {}

// Open the connection to the site while you're on this screen, so going through doesn't start cold.
try {
  const link = Object.assign(document.createElement("link"), { rel: "preconnect", href: new URL(target).origin });
  document.head.append(link);
} catch {}

function sitePill() {
  return host ? `<div class="site"><img src="${favicon(target)}" alt=""><span>${esc(host)}</span></div>` : "";
}

function stats(info: GateInfo) {
  return `<div class="stats num">
    <div><b>${mins(info.remainingMs)}m</b><small>left today</small></div>
    <div><b>${info.sessionsLeft}</b><small>session${info.sessionsLeft === 1 ? "" : "s"} left</small></div>
    <div><b>${info.group.sessionMin}m</b><small>per session</small></div>
  </div>`;
}

function leaveButtons(info: GateInfo, primary = true) {
  const rep = info.replacement?.url ? `<button class="alt" id="instead">${esc(info.replacement.label || "Do something else")}</button>` : "";
  return `<button class="btn ${primary ? "btn-primary" : "btn-ghost"}" id="close">Close tab</button>${rep}`;
}

function wireLeave(info: GateInfo) {
  document.getElementById("close")?.addEventListener("click", () => send({ type: "dismiss" }));
  document.getElementById("instead")?.addEventListener("click", () => send({ type: "dismiss", replacementUrl: info.replacement.url }));
}

function borrowLink(info: GateInfo) {
  if (info.canBorrow) return `<button class="alt" id="borrow">Need it now? Borrow ${info.borrow.minutes} min from tomorrow</button>`;
  if (info.borrowedMs) return `<p class="foot">You already borrowed time for ${esc(info.group.name)} today.</p>`;
  return "";
}

function footer(info: GateInfo) {
  return info.dismissed ? `<p class="foot">You've backed out ${info.dismissed} time${info.dismissed === 1 ? "" : "s"} today. That counts.</p>` : `<p class="foot">&nbsp;</p>`;
}

async function load() {
  clearTimers();
  const info = await send({ type: "gateInfo" });
  if (!info || "missing" in info) {
    app.innerHTML = `<h1>This site isn't limited anymore</h1><a class="btn btn-primary" href="${esc(target)}">Go to ${esc(host)}</a>`;
    return;
  }
  document.title = `${info.group.name} · Speedbump`;
  if (info.status === "active") return location.replace(target);
  const screens = { ready: info.group.confirm ? renderPause : renderSetup, cooldown: renderCooldown, exhausted: renderExhausted };
  screens[info.status](info);
}

// Step 1: the speed bump. Leaving is one click; continuing waits out a breath.
function renderPause(info: GateInfo) {
  let left = info.pauseSec;
  app.innerHTML = `
    ${sitePill()}
    <div>
      <h1>Do you really want ${esc(info.group.name)} right now?</h1>
      <p class="lede">${ordinal(Math.max(1, info.attempts))} try today. Take one breath, then decide.</p>
    </div>
    <div class="breath" aria-hidden="true"><div class="ring"></div><div class="core"><span class="count num" id="count">${left}</span><span class="cue" id="cue">breathe in</span></div></div>
    <div class="actions">
      ${leaveButtons(info)}
    </div>
    <button class="btn btn-ghost" id="go" disabled>Continue in <span class="num" id="go-s">${left}</span>s</button>
    ${stats(info)}
    ${footer(info)}`;
  wireLeave(info);
  const go = $<HTMLButtonElement>("go");
  const started = Date.now();
  timers.push(setInterval(() => {
    left = Math.max(0, info.pauseSec - Math.floor((Date.now() - started) / 1000));
    $("count").textContent = String(left);
    $("go-s").textContent = String(left);
    $("cue").textContent = Math.floor((Date.now() - started) / 4000) % 2 ? "breathe out" : "breathe in";
    if (left === 0) {
      clearTimers();
      go.disabled = false;
      go.textContent = "Continue anyway";
      $("cue").textContent = "your call";
    }
  }, 250));
  go.addEventListener("click", () => renderSetup(info, true));
}

// Step 2: pick a length and, optionally, say what you're there for.
function renderSetup(info: GateInfo, afterPause = false) {
  clearTimers();
  let chosen = info.options[info.options.length - 1];
  app.innerHTML = `
    ${sitePill()}
    <div>
      <h1>${afterPause ? "Okay. Keep it short." : `Start a ${esc(info.group.name)} session`}</h1>
      <p class="lede">The session ends when time's up, when you end it, or after 2 minutes away from the site. Then a ${info.group.cooldownMin} min cooldown.</p>
    </div>
    <div class="setup">
      <div>
        <label>How long?</label>
        <div class="seg" role="group">${info.options.map((m) => `<button type="button" data-m="${m}" aria-pressed="${m === chosen}">${m} min</button>`).join("")}</div>
      </div>
      <div>
        <label for="intent">What are you here to do?</label>
        <input type="text" id="intent" maxlength="80" placeholder="Reply to one message" autocomplete="off">
        <p class="hint">Optional. It sits in the corner of the page while you browse.</p>
      </div>
      <button class="btn btn-primary" id="start">Start ${chosen} min</button>
    </div>
    <div class="actions">${leaveButtons(info, false)}</div>
    ${stats(info)}`;
  wireLeave(info);
  const start = $<HTMLButtonElement>("start");
  const segs = app.querySelectorAll<HTMLButtonElement>(".seg button");
  segs.forEach((b) => b.addEventListener("click", () => {
    chosen = Number(b.dataset.m);
    segs.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    start.textContent = `Start ${chosen} min`;
  }));
  const intent = $<HTMLInputElement>("intent");
  intent.addEventListener("keydown", (e) => { if (e.key === "Enter") start.click(); });
  start.addEventListener("click", async () => {
    start.disabled = true;
    const res = await send({ type: "start", minutes: chosen, intent: intent.value.trim() });
    if (res?.ok) location.replace(target);
    else load();
  });
}

function renderCooldown(info: GateInfo) {
  const until = info.cooldownUntil;
  app.innerHTML = `
    ${sitePill()}
    <div>
      <h1>${esc(info.group.name)} is cooling down</h1>
      <p class="lede">Next session unlocks at ${timeOfDay(until)}. Spacing it out is the whole point.</p>
    </div>
    <div class="big-clock num" id="cd">${clock(until - Date.now())}</div>
    <div class="actions">${leaveButtons(info)}</div>
    ${stats(info)}
    ${borrowLink(info)}
    ${footer(info)}`;
  wireLeave(info);
  document.getElementById("borrow")?.addEventListener("click", () => renderBorrow(info));
  timers.push(setInterval(() => {
    const ms = until - Date.now();
    $("cd").textContent = clock(ms);
    if (ms <= 0) load();
  }, 500));
}

function renderExhausted(info: GateInfo) {
  app.innerHTML = `
    ${sitePill()}
    <div>
      <h1>That's all the ${esc(info.group.name)} for today</h1>
      <p class="lede">You used your ${mins(info.budgetMs)} minutes. It resets at ${timeOfDay(info.resetAt)}.</p>
    </div>
    <div class="actions">${leaveButtons(info)}</div>
    ${borrowLink(info)}
    ${footer(info)}`;
  wireLeave(info);
  document.getElementById("borrow")?.addEventListener("click", () => renderBorrow(info));
}

// Extra time exists, but it costs tomorrow's minutes and about two minutes of effort.
async function renderBorrow(info: GateInfo) {
  clearTimers();
  const b = info.borrow;
  const res = await send({ type: "borrowStart" });
  if (!res?.ok) return load();
  const startedAt = res.startedAt;
  app.innerHTML = `
    ${sitePill()}
    <div>
      <h1>Borrow ${b.minutes} minutes from tomorrow?</h1>
      <p class="lede">Tomorrow's ${esc(info.group.name)} budget drops by ${b.minutes} min. You can do this once a day, and it's slow on purpose.</p>
    </div>
    <div class="actions">${leaveButtons(info)}</div>
    <div class="setup borrow">
      <div>
        <label for="why">Why does this need to happen right now?</label>
        <textarea id="why" rows="3" maxlength="300" placeholder="Be specific. 'I'm bored' is an answer, but write it out."></textarea>
        <p class="hint num" id="whyCount">0 / ${b.minReason} characters</p>
      </div>
      <div>
        <label for="phrase">Type: <span class="said">${esc(b.phrase)}</span></label>
        <input type="text" id="phrase" autocomplete="off" spellcheck="false">
      </div>
      <button class="btn btn-ghost" id="take" disabled>Wait</button>
      <p class="hint">The wait only counts down while this tab is open in front of you.</p>
    </div>`;
  wireLeave(info);
  const why = $<HTMLTextAreaElement>("why");
  const phrase = $<HTMLInputElement>("phrase");
  const take = $<HTMLButtonElement>("take");
  blockPaste(why, phrase);
  let waited = 0;
  let last = Date.now();
  const update = () => {
    const now = Date.now();
    if (document.visibilityState === "visible") waited += now - last;
    last = now;
    const left = Math.max(0, b.waitSec * 1000 - waited, startedAt + b.waitSec * 1000 - now);
    const reason = why.value.trim().length;
    $("whyCount").textContent = `${reason} / ${b.minReason} characters`;
    const ready = reason >= b.minReason && phrase.value === b.phrase;
    if (left > 0) take.innerHTML = `Wait <span class="num">${clock(left)}</span>`;
    else take.textContent = ready ? `Take ${b.minutes} min from tomorrow` : "Finish both fields";
    take.disabled = left > 0 || !ready;
  };
  why.addEventListener("input", update);
  phrase.addEventListener("input", update);
  update();
  timers.push(setInterval(update, 250));
  take.addEventListener("click", async () => {
    take.disabled = true;
    const r = await send({ type: "borrow", reason: why.value, phrase: phrase.value });
    if (r?.ok) location.replace(target);
    else load();
  });
}

load();
