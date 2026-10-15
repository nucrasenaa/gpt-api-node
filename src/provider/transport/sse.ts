/** Small, provider-neutral SSE helpers for browser-shaped streaming responses. */

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export type JsonSseEvent = Record<string, unknown>;

function parseBlock(block: string): SseEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }
  if (data.length === 0 && event === undefined && id === undefined && retry === undefined) return undefined;
  return { ...(event === undefined ? {} : { event }), data: data.join("\n"), ...(id === undefined ? {} : { id }), ...(retry === undefined ? {} : { retry }) };
}

export function parseSseEvents(input: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of input.split(/\r?\n\r?\n/)) {
    const parsed = parseBlock(block);
    if (parsed) events.push(parsed);
  }
  return events;
}

export function jsonEventsFromSseData(data: string): JsonSseEvent[] {
  const normalized = data.trim();
  if (!normalized) return [];
  if (normalized === "[DONE]") return [{ type: "done" }];
  try {
    const parsed: unknown = JSON.parse(normalized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? [parsed as JsonSseEvent]
      : [];
  } catch {
    return [];
  }
}

export function eventsFromEncodedSse(encoded: string): JsonSseEvent[] {
  return parseSseEvents(encoded).flatMap((event) => jsonEventsFromSseData(event.data));
}

export function eventsFromWebSocketItem(item: Record<string, unknown>, topicId: string): JsonSseEvent[] {
  const events: JsonSseEvent[] = [];
  const reply = item.reply;
  if (reply && typeof reply === "object" && !Array.isArray(reply)) {
    const catchups = (reply as Record<string, unknown>).catchups;
    if (Array.isArray(catchups)) {
      for (const catchup of catchups) {
        if (catchup && typeof catchup === "object" && !Array.isArray(catchup)) {
          events.push(...eventsFromWebSocketItem(catchup as Record<string, unknown>, topicId));
        }
      }
    }
  }

  if (item.type !== "message" || item.topic_id !== topicId) return events;
  const payload = item.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return events;
  const conversationStream = payload as Record<string, unknown>;
  if (conversationStream.type !== "conversation-turn-stream") return events;
  const inner = conversationStream.payload;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return events;
  const streamItem = inner as Record<string, unknown>;
  if (streamItem.type === "done") {
    return [{ type: "done", conversation_id: streamItem.conversation_id }];
  }
  if (typeof streamItem.encoded_item === "string") {
    events.push(...eventsFromEncodedSse(streamItem.encoded_item));
  }
  return events;
}

export async function* parseJsonSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitBlocks = (flush: boolean): JsonSseEvent[] => {
    const parts = buffer.split(/\r?\n\r?\n/);
    if (!flush) buffer = parts.pop() ?? "";
    else buffer = "";
    return parts.flatMap((part) => {
      const event = parseBlock(part);
      return event ? jsonEventsFromSseData(event.data) : [];
    });
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (const event of emitBlocks(false)) yield event;
  }
  buffer += decoder.decode();
  for (const event of emitBlocks(true)) yield event;
}

export const parseEventStream = parseJsonSseStream;
