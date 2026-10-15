import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createBridgeServer } from "../server.js";

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
    assert.deepEqual(body.data.map((item) => item.id), ["chatgpt-web/auto", "chatgpt-web"]);
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
    CHATGPT_ACCESS_TOKEN: "token-for-test",
    CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
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
