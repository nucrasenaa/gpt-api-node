import { randomUUID } from "node:crypto";
import type { TransportChatRequest, TransportContentPart, TransportMessage } from "./types.js";

export interface ChatGPTPayloadOptions {
  capturedRequestJson?: Record<string, unknown>;
  timezoneOffsetMinutes?: number;
  timezone?: string;
  idFactory?: () => string;
  now?: () => number;
}

export interface ChatGPTRequestHeaders {
  [name: string]: string;
}

const REPLAYABLE_HEADERS = new Set([
  "accept", "accept-language", "authorization", "cache-control", "chatgpt-account-id", "content-type", "cookie",
  "oai-client-build-number", "oai-client-version", "oai-did", "oai-device-id", "oai-echo-logs", "oai-language",
  "oai-session-id", "oai-telemetry", "openai-sentinel-arkose-token", "openai-sentinel-chat-requirements-token",
  "openai-sentinel-proof-token", "openai-sentinel-turnstile-token", "origin", "originator", "priority", "referer",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "user-agent", "x-conduit-token", "x-oai-mcp-form-version", "x-oai-turn-trace-id", "x-openai-codex-window-type",
  "x-openai-sentinel-prepare-p", "x-openai-target-path", "x-openai-target-route", "x-openai-web-frontend", "x-openai-web-sse-compression",
]);

export function isReplayableRequestHeader(name: string): boolean {
  return REPLAYABLE_HEADERS.has(name.toLowerCase());
}

function localTimezonePayload(): { timezone_offset_min: number; timezone: string } {
  return {
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function stringParts(content: string | TransportContentPart[]): unknown[] {
  if (typeof content === "string") return [content];
  return content.flatMap((part): unknown[] => {
    if (part.type === "text" || typeof part.text === "string") return [part.text ?? ""];
    if (part.type === "image_url" && part.image_url?.url) {
      return [{ type: "image_url", image_url: part.image_url.url }];
    }
    return [];
  });
}

export function messageToChatGPT(message: TransportMessage, idFactory: () => string = () => randomUUID(), now: () => number = Date.now): Record<string, unknown> {
  const parts = stringParts(message.content);
  const hasMedia = parts.some((part) => typeof part === "object" && part !== null);
  return {
    author: { metadata: {}, name: null, role: message.role },
    channel: null,
    create_time: now() / 1000,
    end_turn: null,
    id: idFactory(),
    content: { content_type: hasMedia ? "multimodal_text" : "text", parts },
    metadata: {},
    recipient: "all",
    status: "finished_successfully",
    update_time: null,
    weight: 1,
  };
}

function mergedSystemHints(template: unknown, requested: unknown): string[] {
  const result: string[] = [];
  for (const value of [template, requested]) {
    if (!Array.isArray(value)) continue;
    for (const item of value) if (typeof item === "string" && item && !result.includes(item)) result.push(item);
  }
  return result;
}

function defaultClientContextualInfo(): Record<string, unknown> {
  return {
    is_dark_mode: false,
    time_since_loaded: 20,
    page_height: 900,
    page_width: 1440,
    pixel_ratio: 1,
    screen_height: 1080,
    screen_width: 1920,
    app_name: "chatgpt.com",
  };
}

export function buildChatGPTPayload(
  request: TransportChatRequest,
  options: ChatGPTPayloadOptions = {},
): Record<string, unknown> {
  const metadata = request.metadata ?? {};
  const capturedFromMetadata = metadata.captured_request_json;
  const template = options.capturedRequestJson && typeof options.capturedRequestJson === "object"
    ? options.capturedRequestJson
    : capturedFromMetadata && typeof capturedFromMetadata === "object" && !Array.isArray(capturedFromMetadata)
      ? capturedFromMetadata as Record<string, unknown>
      : {};
  const timezone = localTimezonePayload();
  const idFactory: () => string = options.idFactory ?? (() => randomUUID());
  const now = options.now ?? Date.now;
  const action = request.action ?? "next";
  const hasCapturedTemplate = Object.keys(template).length > 0;
  const payload: Record<string, unknown> = {
    ...template,
    action,
    model: request.model ?? (typeof template.model === "string" ? template.model : "auto"),
    timezone_offset_min: options.timezoneOffsetMinutes ?? timezone.timezone_offset_min,
    timezone: options.timezone ?? timezone.timezone,
  };

  // A real browser capture is the source of truth for the web endpoint. Do not
  // add newer/older routing knobs to that opaque payload: some ChatGPT web
  // deployments route the model from this exact shape. Keep defaults only for
  // callers that do not have a browser capture at all.
  if (!hasCapturedTemplate || Object.hasOwn(template, "conversation_mode")) {
    payload.conversation_mode = template.conversation_mode ?? { kind: "primary_assistant" };
  }
  if (!hasCapturedTemplate || Object.hasOwn(template, "system_hints") || metadata.system_hints !== undefined) {
    const hints = mergedSystemHints(template.system_hints, metadata.system_hints);
    if (hints.length || Object.hasOwn(template, "system_hints") || metadata.system_hints !== undefined) payload.system_hints = hints;
  }
  if (!hasCapturedTemplate || Object.hasOwn(template, "supports_buffering")) {
    payload.supports_buffering = template.supports_buffering ?? true;
  }
  if (!hasCapturedTemplate || Object.hasOwn(template, "supported_encodings")) {
    payload.supported_encodings = template.supported_encodings ?? ["v1"];
  }
  if (!hasCapturedTemplate || Object.hasOwn(template, "client_contextual_info")) {
    payload.client_contextual_info = template.client_contextual_info ?? defaultClientContextualInfo();
  }
  if (!hasCapturedTemplate || Object.hasOwn(template, "paragen_cot_summary_display_override")) {
    payload.paragen_cot_summary_display_override = template.paragen_cot_summary_display_override ?? "allow";
  }
  if (!hasCapturedTemplate || Object.hasOwn(template, "force_parallel_switch")) {
    payload.force_parallel_switch = template.force_parallel_switch ?? "auto";
  }

  // Keep opaque fields from a real browser capture (for example browser_context,
  // turn_attribution, and local_function_names), but never reuse its thread.
  delete payload.conversation_id;
  delete payload.parent_message_id;
  delete payload.messages;
  delete payload.client_prepare_state;

  const conversationId = request.conversationId ?? request.conversation_id;
  const parentMessageId = request.parentMessageId ?? request.parent_message_id;
  const variantPurpose = request.variantPurpose ?? request.variant_purpose;
  const thinkingEffort = request.thinkingEffort ?? request.thinking_effort;
  if (conversationId) payload.conversation_id = conversationId;
  if (parentMessageId) payload.parent_message_id = parentMessageId;
  if (variantPurpose) payload.variant_purpose = variantPurpose;
  if (thinkingEffort) payload.thinking_effort = thinkingEffort;
  if (typeof metadata.history_and_training_disabled === "boolean") {
    payload.history_and_training_disabled = metadata.history_and_training_disabled;
  }
  if (action === "next") {
    payload.parent_message_id ??= "client-created-root";
    payload.client_prepare_state = "success";
    payload.messages = request.messages.map((message) => messageToChatGPT(message, idFactory, now));
  } else if (action === "variant") {
    payload.client_prepare_state = "none";
  } else if (action === "continue") {
    payload.client_prepare_state = "none";
  }
  if (Object.hasOwn(template, "enable_message_followups")) {
    payload.enable_message_followups = template.enable_message_followups;
  }
  return payload;
}

export const buildChatPayload = buildChatGPTPayload;

const PREPARE_KEYS = new Set([
  "action", "conversation_id", "parent_message_id", "model", "client_prepare_state",
  "timezone_offset_min", "timezone", "variant_purpose", "conversation_mode", "system_hints",
  "supports_buffering", "supported_encodings", "thinking_effort", "client_contextual_info",
  "paragen_cot_summary_display_override", "force_parallel_switch", "enable_message_followups",
  "client_prepare_dispatch", "client_prepare_source", "local_function_names", "is_do_not_remember",
]);

export function prepareChatGPTPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const prepared = Object.fromEntries(Object.entries(payload).filter(([key]) => PREPARE_KEYS.has(key)));
  if (payload.action === "next") {
    prepared.client_prepare_state = "sent";
  }
  return prepared;
}

export function markPayloadSentAfterPrepare(payload: Record<string, unknown>): void {
  if (payload.action === "next") payload.client_prepare_state = "success";
}

export function jsonHeadersForTokenRefresh(headers: ChatGPTRequestHeaders): ChatGPTRequestHeaders {
  const blocked = new Set(["accept", "content-length", "x-oai-turn-trace-id", "x-openai-sentinel-prepare-p", "x-openai-target-path", "x-openai-target-route"]);
  const refreshed = Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()) && isReplayableRequestHeader(name)));
  return {
    ...refreshed,
    accept: "*/*",
    "content-type": "application/json",
    "x-conduit-token": "no-token",
    "x-openai-target-path": "/backend-api/f/conversation/prepare",
    "x-openai-target-route": "/backend-api/f/conversation/prepare",
  };
}

export function conversationHeaders(headers: ChatGPTRequestHeaders): ChatGPTRequestHeaders {
  const blocked = new Set(["content-length", "host", "accept-encoding", "x-openai-sentinel-prepare-p"]);
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()) && isReplayableRequestHeader(name))),
    accept: headers.accept ?? "*/*",
    "content-type": "application/json",
  };
}
