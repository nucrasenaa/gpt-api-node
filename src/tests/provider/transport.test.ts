import assert from "node:assert/strict";
import test from "node:test";
import { ChatGPTEndpoints, CHATGPT_CONVERSATION_PATH, conversationEndpoint } from "../../provider/transport/endpoints.js";
import {
  buildChatGPTPayload,
  conversationHeaders,
  jsonHeadersForTokenRefresh,
  markPayloadSentAfterPrepare,
  messageToChatGPT,
  prepareChatGPTPayload,
} from "../../provider/transport/chatgpt-payload.js";
import {
  createDeltaNormalizationState,
  eventToNormalizedDelta,
  normalizeEventDelta,
} from "../../provider/transport/deltas.js";
import {
  eventsFromEncodedSse,
  eventsFromWebSocketItem,
  parseJsonSseStream,
  parseSseEvents,
} from "../../provider/transport/sse.js";
import { decodeProofConfig, generateProofToken } from "../../provider/transport/proof.js";

test("ChatGPT endpoints derive protocol URLs from a custom base", () => {
  const endpoints = new ChatGPTEndpoints({ baseUrl: "https://example.test/" });
  assert.equal(endpoints.conversationUrl, `https://example.test${CHATGPT_CONVERSATION_PATH}`);
  assert.equal(endpoints.streamStatusUrl("conversation/1"), "https://example.test/backend-api/conversation/conversation/1/stream_status");
  assert.equal(conversationEndpoint("https://example.test/"), endpoints.conversationUrl);
  assert.equal(conversationEndpoint("https://example.test", "https://capture.test/conversation"), "https://capture.test/conversation");
});

test("SSE helpers parse fields, multiline data, done markers, and websocket stream items", () => {
  assert.deepEqual(parseSseEvents("event: delta\ndata: {\"v\":\ndata: \"hi\"}\n\nid: 1\n\n"), [
    { event: "delta", data: '{"v":\n"hi"}' },
    { id: "1", data: "" },
  ]);
  assert.deepEqual(eventsFromEncodedSse('event: delta\ndata: {"p":"/message/content/parts/0","v":"hi"}\n\ndata: [DONE]\n\n'), [
    { p: "/message/content/parts/0", v: "hi" },
    { type: "done" },
  ]);
  assert.deepEqual(eventsFromWebSocketItem({
    type: "message",
    topic_id: "topic-1",
    payload: { type: "conversation-turn-stream", payload: { type: "stream-item", encoded_item: 'data: {"v":"hi"}\n\n' } },
  }, "topic-1"), [{ v: "hi" }]);
});

test("stream parser flushes a final event without a trailing blank line", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"v":"hello"}'));
      controller.close();
    },
  });
  const events: Record<string, unknown>[] = [];
  for await (const event of parseJsonSseStream(body)) events.push(event);
  assert.deepEqual(events, [{ v: "hello" }]);
});

test("normalized deltas support patches and cumulative message snapshots", () => {
  assert.deepEqual(eventToNormalizedDelta({ v: [{ p: "/message/content/parts/0", v: "hello" }, { p: "/message/status", v: "finished" }], conversation_id: "c1" }), {
    text: "hello", conversationId: "c1", raw: { v: [{ p: "/message/content/parts/0", v: "hello" }, { p: "/message/status", v: "finished" }], conversation_id: "c1" },
  });
  const state = createDeltaNormalizationState();
  assert.equal(normalizeEventDelta({ message: { content: { parts: ["hel"] } } }, state)?.text, "hel");
  assert.equal(normalizeEventDelta({ message: { content: { parts: ["hello"] } } }, state)?.text, "lo");
});

test("ChatGPT payload builder shapes provider-neutral messages without thread reuse", () => {
  const payload = buildChatGPTPayload({
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    metadata: { history_and_training_disabled: true, system_hints: ["hint-a"] },
  }, {
    capturedRequestJson: {
      model: "captured-model",
      parent_message_id: "captured-parent",
      timezone: "captured/zone",
      browser_context: { instance_id: "browser-123" },
      local_function_names: ["local.continue_in_work"],
      turn_attribution: { turn_trigger: "composer" },
    },
    timezoneOffsetMinutes: -420,
    timezone: "Asia/Bangkok",
    idFactory: () => "message-1",
    now: () => 1_000,
  });

  assert.equal(payload.model, "gpt-test");
  assert.equal(payload.parent_message_id, "client-created-root");
  assert.equal(payload.timezone, "Asia/Bangkok");
  assert.deepEqual(payload.messages, [messageToChatGPT({ role: "user", content: "hello" }, () => "message-1", () => 1_000)]);
  assert.equal(payload.history_and_training_disabled, true);
  assert.deepEqual(payload.system_hints, ["hint-a"]);
  assert.deepEqual(payload.browser_context, { instance_id: "browser-123" });
  assert.deepEqual(payload.local_function_names, ["local.continue_in_work"]);
  assert.deepEqual(payload.turn_attribution, { turn_trigger: "composer" });
  assert.equal("captured-parent" in payload, false);
});

test("prepare and header helpers match the ChatGPT protocol boundary", () => {
  const payload = buildChatGPTPayload({ messages: [{ role: "user", content: "hello" }] }, { idFactory: () => "message-1" });
  const prepared = prepareChatGPTPayload(payload);
  assert.equal(prepared.client_prepare_state, "none");
  assert.equal((prepared.partial_query as { id: string }).id, "message-1");
  assert.equal("messages" in prepared, false);
  markPayloadSentAfterPrepare(payload);
  assert.equal(payload.client_prepare_state, "sent");

  const refreshed = jsonHeadersForTokenRefresh({ accept: "text/event-stream", authorization: "Bearer token", "content-length": "10" });
  assert.equal(refreshed.accept, "*/*");
  assert.equal(refreshed["x-openai-target-path"], "/backend-api/f/conversation/prepare");
  assert.equal("content-length" in refreshed, false);
  const replay = conversationHeaders({ authorization: "Bearer token", host: "example", "accept-encoding": "gzip" });
  assert.equal(replay.accept, "text/event-stream");
  assert.equal("host" in replay, false);
});

test("proof helpers decode captured config and generate a bounded token", () => {
  const config = [1, "date", null, 0, "ua"];
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64").replace(/=+$/, "");
  assert.deepEqual(decodeProofConfig(`gAAAAAB${encoded}~challenge`), config);
  const token = generateProofToken(true, "seed", "", "ua", config);
  assert.ok(token?.startsWith("gAAAAAB"));
});
