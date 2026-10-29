// The contract between the pages and the service worker.
import type { GateInfo, PendingView, Settings, Summary } from "./core.ts";

export type Message =
  | { type: "gateInfo"; groupId: string }
  | { type: "start"; groupId: string; minutes: number; intent?: string }
  | { type: "dismiss"; groupId: string; replacementUrl?: string }
  | { type: "end"; groupId: string }
  | { type: "pill" }
  | { type: "summary" }
  | { type: "saveSettings"; settings: Settings; challenge?: string }
  | { type: "cancelPending" }
  | { type: "applyPending"; challenge: string }
  | { type: "borrowStart"; groupId: string }
  | { type: "borrow"; groupId: string; reason: string; phrase: string };

export interface PillInfo { groupId: string; name: string; end: number; intent: string }

export interface Ok { ok: boolean; error?: string }

export interface Replies {
  gateInfo: GateInfo | { missing: true };
  start: Ok;
  dismiss: unknown;
  end: Ok;
  pill: PillInfo | null;
  summary: Summary;
  saveSettings: { ok: true } | { needsChallenge: string[] } | { pending: PendingView };
  cancelPending: Ok;
  applyPending: Ok;
  borrowStart: { ok: false } | { ok: true; startedAt: number };
  borrow: Ok;
}

export function send<M extends Message>(msg: M): Promise<Replies[M["type"]]> {
  return chrome.runtime.sendMessage(msg);
}
