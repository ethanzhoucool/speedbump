// Floating session timer on limited sites. Shadow DOM keeps the page's CSS out.
// This is a classic content script, so it can't import; PillInfo mirrors messages.ts.
(() => {
  interface PillInfo { groupId: string; name: string; end: number; intent: string }
  const w = window as Window & { __speedbump?: boolean };
  if (window.top !== window || w.__speedbump) return;
  w.__speedbump = true;

  let host: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let info: PillInfo | null = null;

  const fmt = (ms: number) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function mount() {
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { color-scheme: light dark; }
        .p { display:flex; align-items:center; gap:10px; padding:8px 8px 8px 14px; border-radius:999px;
             font:500 13px/1.2 ui-sans-serif,-apple-system,system-ui,sans-serif; color:#ebe8f4;
             background:rgb(22 20 29 / .92); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
             border:1px solid rgb(255 255 255 / .1); box-shadow:0 8px 28px rgb(0 0 0 / .28);
             max-width:min(420px, calc(100vw - 32px)); transition:opacity .2s, transform .2s; }
        .p.min { opacity:.55; }
        .p:hover { opacity:1; }
        .t { font-variant-numeric:tabular-nums; font-weight:700; }
        .t.low { color:#f0a07c; }
        .i { color:#9893aa; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        button { all:unset; cursor:pointer; padding:6px 11px; border-radius:999px; background:rgb(255 255 255 / .08); font-weight:600; font-size:12px; }
        button:hover { background:rgb(255 255 255 / .16); }
        button:focus-visible { outline:2px solid #b7a6f4; outline-offset:2px; }
      </style>
      <div class="p" part="pill">
        <span class="t"></span>
        <span class="i"></span>
        <button type="button" title="End session now and keep the rest of your minutes">End</button>
      </div>`;
    const pill = root.querySelector(".p")!;
    const t = root.querySelector(".t")!;
    const i = root.querySelector(".i")!;
    root.querySelector("button")!.addEventListener("click", () => chrome.runtime.sendMessage({ type: "end", groupId: info?.groupId }));
    document.documentElement.appendChild(host);
    const paint = () => {
      if (!info) return;
      const left = info.end - Date.now();
      t.textContent = fmt(left);
      t.classList.toggle("low", left < 60_000);
      i.textContent = info.intent ? `Here to: ${info.intent}` : info.name;
      pill.classList.toggle("min", left > 120_000);
      if (left <= 0) refresh();
    };
    paint();
    timer = setInterval(paint, 1000);
  }

  function unmount() {
    clearInterval(timer);
    host?.remove();
    host = null;
  }

  async function refresh() {
    try {
      info = await chrome.runtime.sendMessage({ type: "pill" });
    } catch {
      return;
    }
    unmount();
    if (info) mount();
  }

  refresh();
  chrome.storage.onChanged.addListener((c) => { if (c.state) refresh(); });
})();
