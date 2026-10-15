import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { BridgeConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import { ChatGPTWebProvider } from "./provider/chatgpt-web.js";
import type { ChatCompletionRequest, ChatDelta } from "./types.js";

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function errorPayload(error: unknown): { error: { message: string; type: string } } {
  if (error instanceof BridgeError) {
    return { error: { message: error.message, type: error.type } };
  }
  return { error: { message: error instanceof Error ? error.message : "Internal server error", type: "server_error" } };
}

function authorize(req: http.IncomingMessage, config: BridgeConfig): boolean {
  if (!config.apiKey) return true;
  const authorization = req.headers.authorization ?? "";
  return authorization === `Bearer ${config.apiKey}`;
}

function withCors(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "Authorization, Content-Type");
  res.setHeader("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new BridgeError("Request body is too large", 413, "request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(body: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : "Invalid JSON body", 400, "invalid_request_error");
  }
}

function requestId(): string {
  return `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

async function writeChatCompletion(
  res: http.ServerResponse,
  provider: ChatGPTWebProvider,
  request: ChatCompletionRequest,
  stream: boolean,
): Promise<void> {
  const id = requestId();
  const created = Math.floor(Date.now() / 1000);
  let text = "";
  let conversationId: string | undefined;

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for await (const delta of provider.streamChat(request)) {
      text += delta.text;
      conversationId = delta.conversationId ?? conversationId;
      res.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model ?? "chatgpt-web/auto",
        choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
      })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model ?? "chatgpt-web/auto",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      conversation_id: conversationId,
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  for await (const delta of provider.streamChat(request)) {
    text += delta.text;
    conversationId = delta.conversationId ?? conversationId;
  }
  json(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: request.model ?? "chatgpt-web/auto",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    conversation_id: conversationId,
  });
}

export function createBridgeServer(config: BridgeConfig): http.Server {
  const provider = new ChatGPTWebProvider(config);
  return http.createServer(async (req, res) => {
    withCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (!authorize(req, config)) {
        json(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          provider: await provider.status(),
          artifact_downloads: { route: "/v1/chatgpt/files/{id}/{filename}", public_base_url: config.publicBaseUrl },
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        json(res, 200, {
          object: "list",
          data: [
            { id: "chatgpt-web/auto", object: "model", owned_by: "chatgpt-web" },
            { id: "chatgpt-web", object: "model", owned_by: "chatgpt-web" },
          ],
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/chatgpt/admin/status") {
        json(res, 200, { object: "chatgpt.admin.status", provider: await provider.status(), node_version: process.version });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/chatgpt/admin/settings") {
        json(res, 200, {
          object: "chatgpt.admin.settings",
          settings: {
            host: config.host,
            port: config.port,
            public_base_url: config.publicBaseUrl,
            account: config.account ?? null,
            character_game: "removed",
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = parseJsonBody(await readBody(req, config.maxBodyBytes)) as unknown as ChatCompletionRequest;
        if (!Array.isArray(body.messages)) throw new BridgeError("messages must be a list", 400, "invalid_request_error");
        await writeChatCompletion(res, provider, body, body.stream === true);
        return;
      }

      json(res, 404, { error: { message: "Route not found", type: "not_found" } });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof BridgeError ? error.statusCode : 500;
      json(res, status, errorPayload(error));
    }
  });
}
