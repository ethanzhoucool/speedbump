// Small helpers shared by the extension pages.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

export const favicon = (pageUrl: string): string =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);

// Typing it out is the point, so no pasting or dropping text in.
export function blockPaste(...els: HTMLElement[]) {
  for (const el of els) for (const ev of ["paste", "drop"]) el.addEventListener(ev, (e) => e.preventDefault());
}
