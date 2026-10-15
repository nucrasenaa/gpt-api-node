import assert from "node:assert/strict";
import test from "node:test";
import { parseCapture } from "../auth/request-capture.js";

test("parseCapture reads copied cURL headers, cookies, and JSON payload", () => {
  const capture = parseCapture(`curl 'https://chatgpt.com/backend-api/f/conversation' \\
    -H 'Authorization: Bearer token-123' \\
    -H 'Cookie: __Secure-next-auth.session-token=session' \\
    -H 'Content-Type: application/json' \\
    --data-raw '{"action":"next","model":"auto"}'`);

  assert.equal(capture.url, "https://chatgpt.com/backend-api/f/conversation");
  assert.equal(capture.headers.authorization, "Bearer token-123");
  assert.equal(capture.cookies["__Secure-next-auth.session-token"], "session");
  assert.deepEqual(capture.requestJson, { action: "next", model: "auto" });
});

test("parseCapture accepts the simple request summary format", () => {
  const capture = parseCapture(`URL: https://chatgpt.com/backend-api/f/conversation
Authorization: Bearer token-456
Cookie: foo=bar; baz=qux
Request Data: {"action":"next"}`);

  assert.equal(capture.url, "https://chatgpt.com/backend-api/f/conversation");
  assert.equal(capture.headers.authorization, "Bearer token-456");
  assert.deepEqual(capture.cookies, { foo: "bar", baz: "qux" });
  assert.deepEqual(capture.requestJson, { action: "next" });
});

test("parseCapture preserves quoted Chrome headers and current ChatGPT routing headers", () => {
  const capture = parseCapture(`curl --url 'https://chatgpt.com/backend-api/f/conversation' \\
    -H 'chatgpt-account-id: account-123' \\
    -H 'oai-did: device-123' \\
    -H 'originator: Codex Browser' \\
    -H 'sec-ch-ua: "Google Chrome";v="153", "Not_A Brand";v="8"' \\
    -H 'x-oai-mcp-form-version: 2' \\
    -H 'x-openai-codex-window-type: browser' \\
    -H 'x-openai-web-frontend: codex_webview' \\
    -H 'x-openai-web-sse-compression: gzip' \\
    --data-raw '{"action":"next","messages":[]}'`);

  assert.equal(capture.headers["chatgpt-account-id"], "account-123");
  assert.equal(capture.headers["oai-did"], "device-123");
  assert.equal(capture.headers.originator, "Codex Browser");
  assert.equal(capture.headers["sec-ch-ua"], '"Google Chrome";v="153", "Not_A Brand";v="8"');
  assert.equal(capture.headers["x-oai-mcp-form-version"], "2");
  assert.equal(capture.headers["x-openai-codex-window-type"], "browser");
  assert.equal(capture.headers["x-openai-web-frontend"], "codex_webview");
  assert.equal(capture.headers["x-openai-web-sse-compression"], "gzip");
  assert.deepEqual(capture.requestJson, { action: "next", messages: [] });
});
