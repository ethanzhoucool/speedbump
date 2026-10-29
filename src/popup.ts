import { MIN } from "./core.ts";
import type { Summary, SummaryRow } from "./core.ts";
import { send } from "./messages.ts";
import { $, esc, favicon } from "./dom.ts";

const list = $("list");
const tally = $("tally");
const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

let data: Summary | undefined;

function stateText(r: SummaryRow, now: number): [string, string] {
  switch (r.status) {
    case "active": return [`${fmt(r.session!.end - now)} left`, "on"];
    case "cooldown": return [`next at ${new Date(r.cooldownUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "cool"];
    case "exhausted": return ["done for today", "cool"];
    default: return [`${r.sessionsLeft} session${r.sessionsLeft === 1 ? "" : "s"} ready`, ""];
  }
}

function render(data: Summary) {
  const now = Date.now();
  const rows = data.rows.filter((r) => r.group.enabled);
  const attempts = rows.reduce((a, r) => a + r.attempts, 0);
  const dismissed = rows.reduce((a, r) => a + r.dismissed, 0);
  tally.textContent = attempts ? `Stopped at the gate ${attempts} time${attempts === 1 ? "" : "s"}, backed out ${dismissed}.` : "No attempts yet today.";
  const p = data.pending;
  $("banner").textContent = p?.status === "ready" ? "Your settings request is ready to confirm." : p?.status === "waiting" ? `Settings request waiting, ready in ${fmt(p.readyAt - now)}.` : "";
  if (!rows.length) { list.innerHTML = `<li class="empty">No limited sites. Add some in Settings.</li>`; return; }
  list.innerHTML = rows.map((r) => {
    // usedMs was measured at data.now; a live session keeps adding to it.
    const used = r.usedMs + (r.session ? Math.max(0, Math.min(now, r.session.end) - Math.max(r.session.start, data.now)) : 0);
    const budget = r.budgetMs;
    const pct = budget ? Math.min(100, (used / budget) * 100) : 100;
    const [label, cls] = stateText(r, now);
    const total = Math.min(8, Math.ceil(budget / (r.group.sessionMin * MIN)));
    const done = Math.min(total, r.sessions);
    // Sessions left on the left, spent ones on the right, so the row drains right to left.
    const dots = `<span class="dots" title="${done} of ${total} sessions used">${Array.from({ length: total }, (_, i) => `<i class="${i >= total - done ? "used" : ""}"></i>`).join("")}</span>`;
    return `<li class="${r.status === "active" ? "live" : ""}">
      <div class="row"><span class="name"><img class="ico" src="${favicon(`https://${r.group.sites[0] || ""}`)}" alt="">${esc(r.group.name)}</span><span class="state num ${cls}">${label}</span></div>
      <div class="meter ${pct >= 100 ? "full" : ""}"><span style="width:${pct}%"></span></div>
      <div class="row">
        <span class="sub num">${dots}${Math.round(used / MIN)} of ${Math.round(budget / MIN)} min${r.penaltyMs ? ` <span class="debt">(−${Math.round(r.penaltyMs / MIN)} min, borrowed yesterday)</span>` : ""}${r.session?.intent ? ` · ${esc(r.session.intent)}` : ""}</span>
        ${r.status === "active" ? `<button class="btn btn-ghost btn-small" data-end="${esc(r.group.id)}">End now</button>` : ""}
      </div>
    </li>`;
  }).join("");
  list.querySelectorAll<HTMLButtonElement>("[data-end]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    await send({ type: "end", groupId: b.dataset.end! });
    load();
  }));
}

async function load() {
  data = await send({ type: "summary" });
  render(data);
}

load();
setInterval(() => data && render(data), 1000);
