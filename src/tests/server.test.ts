import assert from "node:assert/strict";
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
