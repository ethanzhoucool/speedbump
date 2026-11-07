// Search-only mode: a site that's out of time stays open with only search left. The service worker decides
// when and sends away any URL that isn't part of it. strip.css hides the rest of the page, keyed on the
// attribute set here. The search page is drawn here too, so it keeps working whatever the site changes.
// This is a classic content script, so it can't import; SearchInfo mirrors messages.ts.
(() => {
  interface SearchInfo { groupId: string; name: string; home: string; action: string; param: string; atHome: boolean; until: number }

  const html = document.documentElement;
  let host: HTMLDivElement | null = null;
  let shown = "";
  let video: string | null = null;

  // Hidden until the worker answers, so a feed never flashes first. If it never answers, the site just opens.
  html.dataset.speedbump = "wait";
  const giveUp = setTimeout(() => { if (html.dataset.speedbump === "wait") delete html.dataset.speedbump; }, 2000);

  const STYLE = `
    :host { color-scheme: light dark; --bg:#f6f5fa; --surface:#fff; --line:rgb(30 20 60 / .14); --text:#17151f; --muted:#615c72; --accent:#6c5bc4; --ink:#fff; }
    @media (prefers-color-scheme: dark) { :host { --bg:#0e0d13; --surface:#16141d; --line:rgb(240 235 255 / .14); --text:#ebe8f4; --muted:#9893aa; --accent:#b7a6f4; --ink:#1a1430; } }
    * { box-sizing:border-box; }
    button:focus-visible, a:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .page { position:fixed; inset:0; display:grid; place-content:center; justify-items:center; gap:14px; padding:24px; background:var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif; }
    h1 { margin:0; font-size:24px; font-weight:650; letter-spacing:-.02em; text-align:center; }
    form { display:flex; gap:8px; width:min(560px, calc(100vw - 48px)); margin-top:6px; }
    input { flex:1; min-width:0; padding:12px 18px; border-radius:999px; border:1px solid var(--line); background:var(--surface); color:var(--text); font:inherit; }
    .go { appearance:none; border:0; border-radius:999px; padding:12px 22px; background:var(--accent); color:var(--ink); font:600 14px/1 ui-sans-serif,-apple-system,system-ui,sans-serif; cursor:pointer; }
    .back { margin:0; color:var(--muted); font-size:13px; }
    .more { all:unset; color:var(--muted); font-size:13px; cursor:pointer; text-decoration:underline; text-underline-offset:3px; }
    .more:hover { color:var(--text); }
    .pill { display:flex; align-items:center; gap:8px; padding:8px 8px 8px 14px; border-radius:999px; font:500 13px/1.2 ui-sans-serif,-apple-system,system-ui,sans-serif; color:#ebe8f4; background:rgb(22 20 29 / .92); border:1px solid rgb(255 255 255 / .1); box-shadow:0 8px 28px rgb(0 0 0 / .28); }
    .pill a, .pill button { all:unset; cursor:pointer; padding:6px 11px; border-radius:999px; background:rgb(255 255 255 / .08); font-weight:600; font-size:12px; }
    .pill a:hover, .pill button:hover { background:rgb(255 255 255 / .16); }`;

  const backText = (until: number) => until ? `Full site back at ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "Your time is back for the next page you open.";

  function mount(info: SearchInfo) {
    host = document.createElement("div");
    host.style.cssText = `all:initial;position:fixed;z-index:2147483647;${info.atHome ? "inset:0;" : "right:16px;bottom:16px;"}`;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${STYLE}</style>${info.atHome ? `
      <div class="page">
        <h1>${info.name} is search only</h1>
        <form action="${info.action}" method="get">
          <input name="${info.param}" type="search" placeholder="Search ${info.name}" aria-label="Search ${info.name}" autocomplete="off" required>
          <button class="go">Search</button>
        </form>
        <p class="back">${backText(info.until)}</p>
        <button class="more" data-more>Need more time?</button>
      </div>` : `
      <div class="pill" title="${backText(info.until)}">
        <span>Search only</span>
        <a href="${info.home}">New search</a>
        <button data-more>More time</button>
      </div>`}`;
    root.querySelector("[data-more]")!.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openGate", groupId: info.groupId }));
    // Otherwise the site reads what's typed here as its own keyboard shortcuts.
    for (const type of ["keydown", "keypress", "keyup"]) root.addEventListener(type, (e) => e.stopPropagation());
    html.appendChild(host);
    root.querySelector("input")?.focus();
  }

  async function refresh() {
    let info: SearchInfo | null = null;
    try {
      info = await chrome.runtime.sendMessage({ type: "searchOnly", url: location.href });
    } catch {
      // The extension was reloaded or the worker failed, so the site just opens.
    }
    clearTimeout(giveUp);
    // Autoplay, or anything else that goes straight from one video to another. Reaching a new one takes a search.
    const next = location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;
    if (info && video && next && next !== video) return location.replace(info.home);
    video = next;
    if (!info) delete html.dataset.speedbump;
    else html.dataset.speedbump = info.atHome ? "home" : info.name.toLowerCase();
    const key = JSON.stringify(info);
    if (key === shown) return;
    shown = key;
    host?.remove();
    host = null;
    if (info) mount(info);
  }

  chrome.runtime.onMessage.addListener((m: { type?: string }) => { if (m?.type === "searchOnlyChanged") refresh(); });
  refresh();
})();
