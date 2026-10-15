/** Provider-neutral request and streaming types used by transport helpers. */

export type TransportRole = "system" | "user" | "assistant" | "tool";

export interface TransportContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  [key: string]: unknown;
}

export interface TransportMessage {
  role: TransportRole | string;
  content: string | TransportContentPart[];
}

export interface TransportChatRequest {
  messages: TransportMessage[];
  model?: string;
  action?: "next" | "continue" | "variant" | string;
  conversationId?: string;
  conversation_id?: string;
  parentMessageId?: string;
  parent_message_id?: string;
  variantPurpose?: string;
  variant_purpose?: string;
  thinkingEffort?: string;
  thinking_effort?: string;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

export interface NormalizedDelta {
  text: string;
  role?: TransportRole | string;
  conversationId?: string;
  raw?: unknown;
  done?: boolean;
}

// Short aliases keep the neutral transport boundary convenient for callers
// that do not use the longer names in this module.
export type ChatRole = TransportRole;
export type ContentPart = TransportContentPart;
export type Message = TransportMessage;
export type ChatRequest = TransportChatRequest;
export type ChatDelta = NormalizedDelta;
