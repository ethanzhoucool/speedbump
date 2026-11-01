// The agent pass page. Claude in Chrome can't open extension pages, so this takes over
// https://example.com/#speedbump=<url> instead. Solving the integral unlocks that one tab.
// This is a classic content script, so it can't import; the view mirrors AgentProblemView in messages.ts.
(() => {
  interface View { name: string; text: string; latex: string; minutes: number; expiresAt: number }
  type Reply = View | { missing: true };
  const PREFIX = "#speedbump=";
  if (window.top !== window || !location.hash.startsWith(PREFIX)) return;
  let target = "";
  try { target = decodeURIComponent(location.hash.slice(PREFIX.length)); } catch { return; }

  let timer: ReturnType<typeof setInterval> | undefined;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", id = ""): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (id) e.id = id;
    return e;
  };

  // Retyping the problem is the slow part for a person, so it can't be selected or copied.
  for (const ev of ["copy", "cut", "contextmenu", "selectstart", "dragstart"]) document.addEventListener(ev, (e) => e.preventDefault(), true);

  document.title = "Agent pass · Speedbump";
  document.head.append(Object.assign(el("style"), { textContent: `
    :root { color-scheme: light dark; }
    body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 32px 16px; box-sizing: border-box;
           font: 15px/1.5 ui-sans-serif, -apple-system, system-ui, sans-serif; background: #16141d; color: #ebe8f4; }
    main { width: 100%; max-width: 620px; display: grid; gap: 18px; user-select: none; -webkit-user-select: none; }
    h1 { margin: 0; font-size: 26px; }
    p { margin: 0; }
    .muted { color: #9893aa; font-size: 13.5px; }
    #problem { font-size: 17px; line-height: 1.7; padding: 16px; border-radius: 12px; background: rgb(255 255 255 / .06); }
    #latex { font: 12px/1.5 ui-monospace, monospace; color: #9893aa; word-break: break-all; }
    form { display: flex; gap: 8px; }
    input { flex: 1; min-width: 0; padding: 11px 13px; border-radius: 10px; border: 1px solid rgb(255 255 255 / .15);
            background: rgb(255 255 255 / .04); color: inherit; font: 14px ui-monospace, monospace; }
    button { padding: 11px 18px; border-radius: 10px; border: 0; background: #7d6bd6; color: #fff; font: 600 14px ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    #status { min-height: 1.5em; color: #f0a07c; font-size: 13.5px; }
    #left { font-variant-numeric: tabular-nums; }
  ` }));

  async function load(note = "") {
    clearInterval(timer);
    const main = el("main");
    document.body.replaceChildren(main);
    let view: Reply;
    try {
      view = await chrome.runtime.sendMessage({ type: "agentProblem", url: target });
    } catch {
      main.append(el("h1", "Speedbump isn't responding"), el("p", "Reload the page to try again.", "status"));
      return;
    }
    if (!view || "missing" in view) {
      main.append(el("h1", "Nothing to unlock"), el("p", "That address isn't one Speedbump limits.", "status"));
      return;
    }
    const v = view;
    const left = el("span", "", "left");
    const sub = el("p", "", "");
    sub.className = "muted";
    sub.append(`Solve it to open ${v.name} in this tab for ${v.minutes} minutes. Other tabs stay limited and your budget doesn't change. `, left);
    const input = Object.assign(el("input", "", "answer"), { autocomplete: "off", spellcheck: false, placeholder: "n/d" });
    input.setAttribute("aria-label", "Answer as a fraction n/d");
    for (const ev of ["paste", "drop"]) input.addEventListener(ev, (e) => e.preventDefault());
    const submit = el("button", "Unlock", "submit");
    const form = el("form");
    form.append(input, submit);
    const status = el("p", note, "status");
    main.append(el("h1", "Agent pass"), sub, el("p", v.text, "problem"), el("p", v.latex, "latex"), form, status);
    input.focus();

    const paint = () => {
      const s = Math.max(0, Math.ceil((v.expiresAt - Date.now()) / 1000));
      left.textContent = `${s}s left.`;
      if (s > 0) return;
      clearInterval(timer);
      submit.disabled = input.disabled = true;
      status.textContent = "Time's up.";
      const again = el("button", "New problem");
      again.addEventListener("click", () => load());
      main.append(again);
    };
    paint();
    timer = setInterval(paint, 250);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: "agentPass", url: target, answer: input.value });
      if (r?.ok) return location.replace(target);
      load(`${r?.error || "Didn't work"}. Here's a new one.`);
    });
  }

  load();
})();
