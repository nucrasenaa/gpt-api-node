import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createBridgeServer } from "../server.js";
import { ChatGPTWebProvider } from "../provider/chatgpt-web.js";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "8000",
    CHATGPT_API_KEY: "test-key",
    CHATGPT_ACCOUNTS_DIR: "/tmp/gpt-bridge-node-test-accounts",
  });
  const server = createBridgeServer(config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health requires the configured bearer key", async () => {
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/health`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/health`, { headers: { authorization: "Bearer test-key" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; settings?: unknown };
    assert.equal(body.ok, true);
  });
});

test("models route exposes the compatibility model aliases", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: "Bearer test-key" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<{ id: string }> };
    assert.deepEqual(body.data.map((item) => item.id), ["chatgpt-web/auto", "chatgpt-web", "auto", "chatgpt-deep-research", "gpt-5-5", "gpt-5-5-thinking", "gpt-5-5-thinking-medium", "gpt-5-5-thinking-high", "gpt-5-5-thinking-xhigh", "gpt-5-5-pro", "gpt-5-5-pro-medium", "gpt-5-5-pro-high", "gpt-5-5-pro-xhigh"]);
  });
});

test("chat facade converts provider SSE into an OpenAI-shaped response", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({ message: { content: { parts: ["hello from provider"] } }, conversation_id: "conv-test" })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "8000",
    CHATGPT_API_KEY: "test-key",
    CHATGPT_ACCOUNTS_DIR: "/tmp/gpt-bridge-node-test-chat-accounts",
    CHATGPT_ACCESS_TOKEN: "token-for-test",
    CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
    CHATGPT_REFRESH_WEB_TOKENS: "false",
  });
  const bridge = createBridgeServer(config);
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeAddress = bridge.address();
  assert.ok(bridgeAddress && typeof bridgeAddress !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${bridgeAddress.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/auto", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { choices: Array<{ message: { content: string } }>; conversation_id: string };
    assert.equal(body.choices[0]?.message.content, "hello from provider");
    assert.equal(body.conversation_id, "conv-test");
  } finally {
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("provider refreshes web tokens before the conversation request", async () => {
  const paths: string[] = [];
  const upstream = http.createServer((req, res) => {
    paths.push(req.url ?? "");
    if (req.url?.endsWith("/conversation/prepare")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ conduit_token: "conduit-test" }));
      return;
    }
    if (req.url?.endsWith("/sentinel/chat-requirements/finalize")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "requirements-test" }));
      return;
    }
    if (req.url?.endsWith("/sentinel/chat-requirements")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ prepare_token: "prepare-test", proofofwork: { required: false }, turnstile: { required: false } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ message: { content: { parts: ["refreshed"] } }, conversation_id: "conv-refresh" })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  try {
    const provider = new ChatGPTWebProvider(loadConfig({ CHATGPT_ACCESS_TOKEN: "token", CHATGPT_BASE_URL: `http://127.0.0.1:${address.port}`, CHATGPT_WEB_TIMEOUT: "5000" }));
    const chunks: string[] = [];
    for await (const delta of provider.streamChat({ messages: [{ role: "user", content: "hello" }] })) chunks.push(delta.text);
    assert.equal(chunks.join(""), "refreshed");
    assert.deepEqual(paths, ["/backend-api/f/conversation/prepare", "/backend-api/sentinel/chat-requirements", "/backend-api/sentinel/chat-requirements/finalize", "/backend-api/f/conversation"]);
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
