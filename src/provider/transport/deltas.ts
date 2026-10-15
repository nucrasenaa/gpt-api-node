import type { NormalizedDelta } from "./types.js";

export type ProviderEvent = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function extractEventText(value: unknown, path?: unknown): string {
  if (typeof value === "string") {
    if (typeof path === "string" && path && !path.startsWith("/message/content/parts")) return "";
    return value;
  }
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const part = record(item);
    return typeof part?.v === "string" && typeof part.p === "string" && part.p.startsWith("/message/content/parts")
      ? part.v
      : "";
  }).join("");
}

export const extractText = extractEventText;

export function textFromMessageEvent(event: ProviderEvent): string {
  const message = record(event.message);
  const content = record(message?.content);
  const parts = content?.parts;
  return Array.isArray(parts) ? parts.filter((part): part is string => typeof part === "string").join("") : "";
}

export function eventToNormalizedDelta(event: ProviderEvent): NormalizedDelta | undefined {
  const conversationId = typeof event.conversation_id === "string"
    ? event.conversation_id
    : typeof event.conversationId === "string" ? event.conversationId : undefined;
  const text = Object.hasOwn(event, "v") ? extractEventText(event.v, event.p) : textFromMessageEvent(event);
  if (text) return { text, conversationId, raw: event };
  const eventType = event.type ?? event.event;
  if (eventType === "done" || eventType === "[DONE]") return { text: "", conversationId, raw: event, done: true };
  if (eventType === "resume_conversation_token") return { text: "", conversationId, raw: event };
  return event && Object.keys(event).length > 0 ? { text: "", conversationId, raw: event } : undefined;
}

export const eventToDelta = eventToNormalizedDelta;

export interface DeltaNormalizationState {
  lastText: string;
}

export function createDeltaNormalizationState(): DeltaNormalizationState {
  return { lastText: "" };
}

/** Converts cumulative ChatGPT message snapshots into append-only deltas. */
export function normalizeEventDelta(event: ProviderEvent, state: DeltaNormalizationState): NormalizedDelta | undefined {
  const direct = eventToNormalizedDelta(event);
  if (!direct || direct.done || Object.hasOwn(event, "v")) return direct;
  if (!direct.text) return direct;
  const text = direct.text.startsWith(state.lastText) ? direct.text.slice(state.lastText.length) : direct.text;
  state.lastText = direct.text;
  return text ? { ...direct, text } : { ...direct, text: "" };
}
