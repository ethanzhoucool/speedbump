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
  | { type: "borrow"; groupId: string; reason: string; phrase: string }
  | { type: "agentProblem"; url: string }
  | { type: "agentPass"; url: string; answer: string }
  | { type: "nuclear"; minutes: number }
  | { type: "searchOnly"; url: string }
  | { type: "openGate"; groupId: string }
  | { type: "videoEnded"; groupId: string };

export interface PillInfo { groupId: string; name: string; end: number; intent: string }

// strip.ts is a classic content script and keeps its own copy of this shape.
export interface SearchInfo { groupId: string; name: string; home: string; action: string; param: string; atHome: boolean; until: number }

export interface Ok { ok: boolean; error?: string }

// agent.ts is a classic content script and keeps its own copy of this shape.
export interface AgentProblemView { name: string; text: string; latex: string; minutes: number; expiresAt: number }

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
  agentProblem: AgentProblemView | { missing: true };
  agentPass: Ok;
  nuclear: { until: number };
  searchOnly: SearchInfo | "session" | null;
  openGate: Ok;
  videoEnded: Ok;
}

export function send<M extends Message>(msg: M): Promise<Replies[M["type"]]> {
  return chrome.runtime.sendMessage(msg);
}
