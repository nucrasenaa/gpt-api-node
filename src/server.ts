import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import type { BridgeConfig } from "./config.js";
import { BridgeError, ProviderError, ProviderNotConfiguredError } from "./errors.js";
import { imageExtension, imageInputsFromBody } from "./media/image-inputs.js";
import { defaultOperationRegistry, type OperationRecord } from "./operations/registry.js";
import { ChatGPTWebProvider } from "./provider/chatgpt-web.js";
import { AccountRouter } from "./routing/router.js";
import {
  discoverAccounts,
  inferAccountCapabilities,
  detectAccountInfo,
  listAccountProfiles,
  resolveAccountCapturePath,
  resolveAccountSettingsPath,
  validateAccountName,
} from "./routing/accounts.js";
import { loadSecretsKey } from "./security/crypto.js";
import { writeCaptureFile } from "./storage/accounts.js";
import { BridgeAdminStore } from "./storage/admin-store.js";
import { createArtifactMetadata, guessContentType } from "./storage/artifacts.js";
import type { ChatCompletionRequest, ImageResponse } from "./types.js";
import { parseCapture } from "./auth/request-capture.js";

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function errorPayload(error: unknown): { error: { message: string; type: string } } {
  if (error instanceof BridgeError) return { error: { message: error.message, type: error.type } };
  return { error: { message: error instanceof Error ? error.message : "Internal server error", type: "server_error" } };
}

function withCors(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "Authorization, Content-Type, X-ChatGPT-Operation-Id");
  res.setHeader("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
}

function authorize(req: http.IncomingMessage, config: BridgeConfig): boolean {
  if (!config.apiKey) return true;
  return req.headers.authorization === `Bearer ${config.apiKey}`;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestId(): string {
  return `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function operationIdFrom(body: Record<string, unknown>, req: http.IncomingMessage): string | undefined {
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};
  return stringValue(body.chatgpt_operation_id)
    ?? stringValue(metadata.chatgpt_operation_id)
    ?? stringValue(req.headers["x-chatgpt-operation-id"]);
}

function runtimeAccountNames(config: BridgeConfig): string[] {
  if (config.accounts.length) return [...config.accounts];
  if (config.account) return [config.account];
  return listAccountProfiles(config.accountsDir).filter((profile) => profile.exists).map((profile) => profile.name);
}

function providerConfig(config: BridgeConfig, account: string | undefined): BridgeConfig {
  if (!account) return config;
  return { ...config, account, requestPath: undefined, accessToken: undefined, proofToken: undefined, turnstileToken: undefined };
}

function routerFor(config: BridgeConfig): AccountRouter | undefined {
  const accounts = runtimeAccountNames(config);
  return accounts.length ? new AccountRouter(accounts, config.accountStrategy) : undefined;
}

function configForRequest(config: BridgeConfig, body: Record<string, unknown>): BridgeConfig {
  const requestedAccount = stringValue(body.chatgpt_account) ?? stringValue(body.account);
  const rawAccounts = Array.isArray(body.chatgpt_accounts) ? body.chatgpt_accounts.filter((item): item is string => typeof item === "string") : typeof body.chatgpt_accounts === "string" ? body.chatgpt_accounts.split(",") : undefined;
  const requestedAccounts = rawAccounts?.map((item) => item.trim()).filter(Boolean);
  for (const account of [requestedAccount, ...(requestedAccounts ?? [])]) if (account) validateAccountName(account);
  return {
    ...config,
    account: requestedAccount ?? config.account,
    accounts: requestedAccounts?.length ? requestedAccounts : requestedAccount ? [requestedAccount] : config.accounts,
    accountStrategy: stringValue(body.chatgpt_account_strategy) ?? config.accountStrategy,
  };
}

function retryableProviderError(error: unknown): boolean {
  return error instanceof ProviderError || error instanceof ProviderNotConfiguredError;
}

interface ChatRunResult {
  text: string;
  account?: string;
  conversationId?: string;
  report?: Record<string, unknown>;
}

function isResearchRequest(request: ChatCompletionRequest): boolean {
  const model = typeof request.model === "string" ? request.model.toLowerCase() : "";
  const metadata = request.metadata && typeof request.metadata === "object" && !Array.isArray(request.metadata) ? request.metadata as Record<string, unknown> : {};
  return model.includes("deep-research") || metadata.deep_research === true || metadata.research === true;
}

function latestUserPrompt(request: ChatCompletionRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ").trim();
  }
  return "Research request";
}

function generatedResearchFilename(prompt: string): string {
  const slug = safeFilename(prompt.toLowerCase()).slice(0, 56) || "deep-research";
  return `${Date.now()}-${slug}.md`;
}

async function saveResearchReport(config: BridgeConfig, request: ChatCompletionRequest, result: ChatRunResult, store: BridgeAdminStore): Promise<Record<string, unknown>> {
  const metadata = request.metadata && typeof request.metadata === "object" && !Array.isArray(request.metadata) ? request.metadata as Record<string, unknown> : {};
  const outputPath = stringValue(request.output_path) ?? stringValue(request.path) ?? stringValue(metadata.output_path) ?? stringValue(metadata.path);
  const outputDir = stringValue(request.output_dir) ?? stringValue(metadata.output_dir) ?? config.researchOutputDir;
  const target = outputPath ? (path.extname(outputPath) ? outputPath : path.join(outputPath, generatedResearchFilename(latestUserPrompt(request)))) : path.join(outputDir, generatedResearchFilename(latestUserPrompt(request)));
  const markdown = `# Research report\n\n> Generated by the Node bridge's ChatGPT Web compatibility flow.\n\n${result.text}\n`;
  await fsPromises.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fsPromises.writeFile(path.resolve(target), markdown, { encoding: "utf8", mode: 0o600 });
  const asset = createArtifactMetadata(target, { publicBaseUrl: config.publicBaseUrl, contentType: "text/markdown; charset=utf-8" });
  store.recordArtifact(asset, { kind: "research", account: result.account, prompt: latestUserPrompt(request), metadata: { compatibility_mode: "chat-fallback", requested_model: request.model } });
  return { path: asset.path, download_url: asset.download_url, file_id: asset.id, filename: asset.filename, compatibility_mode: "chat-fallback" };
}

async function runResearch(config: BridgeConfig, request: ChatCompletionRequest, operation: OperationRecord | undefined, store: BridgeAdminStore): Promise<ChatRunResult> {
  const result = await runChat(config, request, operation);
  const report = await saveResearchReport(config, request, result, store);
  return { ...result, report };
}

async function runChat(
  config: BridgeConfig,
  request: ChatCompletionRequest,
  operation: OperationRecord | undefined,
  inputImages: import("./types.js").ImageInput[] = [],
): Promise<ChatRunResult> {
  const router = routerFor(config);
  const candidates: Array<string | undefined> = router ? [...router.order()] : [undefined];
  let lastError: unknown;
  for (const account of candidates) {
    const provider = new ChatGPTWebProvider(providerConfig(config, account));
    const unregisterCancel = operation ? defaultOperationRegistry.registerCancellation(operation.id, async (record) => {
      if (record.conversationId) {
        try { record.lastCancelResult = await provider.stopConversation(record.conversationId); } catch (error) { record.lastCancelError = error instanceof Error ? error.message : String(error); }
      }
    }) : undefined;
    try {
      const consume = async (): Promise<ChatRunResult> => {
        let text = "";
        let conversationId: string | undefined;
        for await (const delta of provider.streamChat(request, inputImages, { signal: operation?.signal })) {
          text += delta.text;
          conversationId = delta.conversationId ?? conversationId;
          if (operation && conversationId) defaultOperationRegistry.update(operation.id, { conversationId, provider, account, status: "running" });
        }
        if (!text.trim()) throw new ProviderError("ChatGPT returned an empty assistant response");
        return { text: text.trim(), account, conversationId };
      };
      const result = account && router ? await router.concurrency.run(account, consume) : await consume();
      if (account) router?.markSuccess(account);
      if (operation) defaultOperationRegistry.update(operation.id, { account, provider, conversationId: result.conversationId, status: "completed", completed: true });
      return result;
    } catch (error) {
      lastError = error;
      if (account) router?.markFailure(account);
      if (!retryableProviderError(error) || account === candidates[candidates.length - 1]) throw error;
    } finally {
      unregisterCancel?.();
    }
  }
  throw lastError ?? new ProviderError("No ChatGPT accounts are configured");
}

function createOperation(kind: string, id?: string): OperationRecord {
  const operation = defaultOperationRegistry.create(kind, id);
  defaultOperationRegistry.start(operation.id);
  return operation;
}

function openAIResponse(request: ChatCompletionRequest, result: ChatRunResult, operation?: OperationRecord): Record<string, unknown> {
  return {
    id: requestId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model ?? "chatgpt-web/auto",
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    chatgpt_account: result.account ?? null,
    chatgpt_conversation_id: result.conversationId ?? null,
    conversation_id: result.conversationId ?? null,
    ...(result.report ? { chatgpt_research: result.report } : {}),
    ...(operation ? { chatgpt_operation_id: operation.id } : {}),
  };
}

async function sendChatStream(
  res: http.ServerResponse,
  config: BridgeConfig,
  request: ChatCompletionRequest,
  operation: OperationRecord,
): Promise<void> {
  const id = requestId();
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  const base = { id, object: "chat.completion.chunk", created, model: request.model ?? "chatgpt-web/auto", chatgpt_operation_id: operation.id };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
  const router = routerFor(config);
  const candidates: Array<string | undefined> = router ? [...router.order()] : [undefined];
  let emitted = false;
  let lastError: unknown;
  for (const account of candidates) {
    const provider = new ChatGPTWebProvider(providerConfig(config, account));
    const unregisterCancel = defaultOperationRegistry.registerCancellation(operation.id, async (record) => {
      if (record.conversationId) {
        try { record.lastCancelResult = await provider.stopConversation(record.conversationId); } catch (error) { record.lastCancelError = error instanceof Error ? error.message : String(error); }
      }
    });
    try {
      const operationRun = async (): Promise<void> => {
        for await (const delta of provider.streamChat(request, [], { signal: operation.signal })) {
          emitted = emitted || Boolean(delta.text);
          if (delta.conversationId) defaultOperationRegistry.update(operation.id, { conversationId: delta.conversationId, account, provider, status: "running" });
          if (delta.text) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }], ...(delta.conversationId ? { chatgpt_conversation_id: delta.conversationId } : {}) })}\n\n`);
        }
      };
      if (account && router) await router.concurrency.run(account, operationRun); else await operationRun();
      if (account) router?.markSuccess(account);
      defaultOperationRegistry.complete(operation.id);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    } catch (error) {
      lastError = error;
      if (account) router?.markFailure(account);
      if (emitted || !retryableProviderError(error) || account === candidates[candidates.length - 1]) break;
    } finally {
      unregisterCancel();
    }
  }
  defaultOperationRegistry.fail(operation.id, lastError);
  const message = lastError instanceof Error ? lastError.message : "ChatGPT provider error";
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: `ChatGPT provider error: ${message}` }, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "download";
}

function generatedFilename(prompt: string, extension: string, index = 0): string {
  const slug = safeFilename(prompt.toLowerCase()).slice(0, 48) || "image";
  return `${Date.now()}-${slug}${index ? `-${index + 1}` : ""}${extension}`;
}

async function saveImageResponse(
  config: BridgeConfig,
  response: ImageResponse,
  body: Record<string, unknown>,
  account: string | undefined,
  store: BridgeAdminStore,
): Promise<Record<string, unknown>> {
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata as Record<string, unknown> : {};
  const responseFormat = stringValue(body.response_format) ?? "url";
  if (responseFormat !== "url" && responseFormat !== "b64_json") throw new BridgeError("response_format must be either url or b64_json", 400, "invalid_request_error");
  const outputPath = stringValue(body.output_path) ?? stringValue(body.path) ?? stringValue(metadata.output_path) ?? stringValue(metadata.path);
  const outputDir = stringValue(body.output_dir) ?? stringValue(metadata.output_dir) ?? config.imageOutputDir;
  const entries: Record<string, string>[] = [];
  for (let index = 0; index < response.images.length; index += 1) {
    const image = response.images[index];
    if (!image) continue;
    let filePath: string | undefined;
    if (image.data) {
      filePath = outputPath
        ? (path.extname(outputPath) ? outputPath : path.join(outputPath, generatedFilename(response.prompt, imageExtension(image.mimeType), index)))
        : path.join(outputDir, generatedFilename(response.prompt, imageExtension(image.mimeType), index));
      await fsPromises.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
      await fsPromises.writeFile(path.resolve(filePath), image.data, { mode: 0o600 });
    }
    if (filePath) {
      const asset = createArtifactMetadata(filePath, { publicBaseUrl: config.publicBaseUrl, contentType: image.mimeType ?? guessContentType(filePath) });
      store.recordArtifact(asset, { kind: "image", account, prompt: response.prompt, metadata: { requested_model: body.model, response_format: responseFormat } });
      if (responseFormat === "b64_json" && image.data) entries.push({ b64_json: image.data.toString("base64"), path: asset.path, download_url: asset.download_url, file_id: asset.id });
      else entries.push({ url: asset.download_url, download_url: asset.download_url, path: asset.path, filename: asset.filename, file_id: asset.id });
    } else if (image.url) {
      entries.push({ url: image.url });
    }
  }
  return { created: Math.floor(Date.now() / 1000), model: body.model ?? "chatgpt-web/auto", data: entries, ...(account ? { chatgpt_account: account } : {}) };
}

async function serveArtifact(req: http.IncomingMessage, res: http.ServerResponse, store: BridgeAdminStore, fileId: string): Promise<void> {
  const artifact = store.getArtifact(fileId);
  if (!artifact) { json(res, 404, { error: { message: "artifact not found", type: "not_found" } }); return; }
  if (!fs.existsSync(artifact.path) || !fs.statSync(artifact.path).isFile()) { json(res, 410, { error: { message: "artifact file is no longer available", type: "gone" } }); return; }
  const filename = artifact.filename.replace(/[\r\n"\\]/g, "_");
  const size = fs.statSync(artifact.path).size;
  res.writeHead(200, { "content-type": artifact.content_type, "content-length": size, "cache-control": "private, max-age=31536000", "content-disposition": `inline; filename="${filename}"`, "x-content-type-options": "nosniff" });
  if (req.method === "HEAD") { res.end(); return; }
  fs.createReadStream(artifact.path).pipe(res);
}

function adminStatus(config: BridgeConfig, store: BridgeAdminStore): Record<string, unknown> {
  return {
    object: "chatgpt.admin.status",
    ok: true,
    server: { host: config.host, port: config.port, public_base_url: config.publicBaseUrl, api_key_required: Boolean(config.apiKey), auth_mode: config.apiKey ? "bearer" : "none", console_url: config.consoleUrl },
    routing: { account: config.account ?? null, accounts: runtimeAccountNames(config), account_strategy: config.accountStrategy, model_fallback: config.modelFallback ?? "none", temporary_chat: config.temporaryChat, character_game: "removed" },
    storage: { admin_db_path: store.path, image_output_dir: config.imageOutputDir, research_output_dir: config.researchOutputDir, artifact_count: store.artifactCount() },
    routes: { health: "/health", models: "/v1/models", chat: "/v1/chat/completions", images: "/v1/images/generations", image_edits: "/v1/images/edits", vision: "/v1/chatgpt/vision", research: "/v1/chat/completions (model=chatgpt-deep-research)", files: "/v1/chatgpt/files/{id}/{filename}", operation: "/v1/chatgpt/operations/{operation_id}", operation_cancel: "/v1/chatgpt/operations/{operation_id}/cancel", admin_api: "/v1/chatgpt/admin/*" },
  };
}

function inspectCapture(text: string): Record<string, unknown> {
  try {
    const capture = parseCapture(text);
    const info = detectAccountInfo(capture);
    const checks = [
      { name: "url", level: "required", ok: Boolean(capture.url && capture.url.includes("chatgpt.com")), detail: capture.url ?? "capture URL was not found" },
      { name: "authorization", level: "required", ok: Boolean(capture.headers.authorization?.toLowerCase().startsWith("bearer ")), detail: capture.headers.authorization ? "Bearer header found" : "authorization header missing" },
      { name: "cookie", level: "required", ok: Boolean(capture.headers.cookie || Object.keys(capture.cookies).length), detail: `${Object.keys(capture.cookies).length} cookies` },
      { name: "request_json", level: "required", ok: Boolean(capture.requestJson || capture.url?.includes("/conversation/prepare")), detail: capture.requestJson ? "payload parsed" : capture.url?.includes("/conversation/prepare") ? "prepare capture; payload can be inferred" : "request JSON was not found" },
      { name: "model", level: "recommended", ok: Boolean((capture.requestJson as Record<string, unknown> | undefined)?.model || capture.url?.includes("/conversation/prepare")), detail: String((capture.requestJson as Record<string, unknown> | undefined)?.model ?? "not provided") },
      { name: "action", level: "recommended", ok: Boolean((capture.requestJson as Record<string, unknown> | undefined)?.action || capture.url?.includes("/conversation/prepare")), detail: String((capture.requestJson as Record<string, unknown> | undefined)?.action ?? "not provided") },
    ];
    for (const name of ["openai-sentinel-chat-requirements-token", "openai-sentinel-proof-token", "openai-sentinel-turnstile-token", "x-conduit-token", "oai-device-id", "oai-session-id"]) checks.push({ name, level: "recommended", ok: Boolean(capture.headers[name]), detail: capture.headers[name] ? "present" : "missing" });
    const missing = checks.filter((check) => check.level === "required" && !check.ok).map((check) => check.name);
    const warnings = checks.filter((check) => check.level === "recommended" && !check.ok).map((check) => check.name);
    return { ok: missing.length === 0, missing, warnings, detected: info.toRedactedDict(), capabilities: inferAccountCapabilities(info), checks, redacted_headers: Object.fromEntries(Object.keys(capture.headers).map((key) => [key, ["authorization", "cookie", "openai-sentinel-proof-token", "openai-sentinel-chat-requirements-token"].includes(key) ? "<redacted>" : capture.headers[key]])) };
  } catch (error) {
    return { ok: false, missing: ["parse"], warnings: [], detected: {}, capabilities: {}, checks: [{ name: "parse", level: "required", ok: false, detail: error instanceof Error ? error.message : String(error) }] };
  }
}

function opencodeConfigPath(input?: string): string {
  const configured = input?.trim();
  if (configured) return configured.startsWith("~/") ? path.join(process.env.HOME ?? "~", configured.slice(2)) : configured;
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "~", ".config"), "opencode", "opencode.json");
}

function opencodeBackupPath(configPath: string): string { return `${configPath}.chatgpt-api.bak`; }
function opencodeStatePath(): string { return path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "~", ".config"), "chatgpt-api", "opencode-setup.json"); }

function readJsonFile(pathname: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pathname, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

async function writeJsonFile(pathname: string, value: Record<string, unknown>): Promise<void> {
  await fsPromises.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function opencodeStatus(config: BridgeConfig, configPath = opencodeConfigPath()): Record<string, unknown> {
  const current = readJsonFile(configPath);
  const provider = current.provider && typeof current.provider === "object" && !Array.isArray(current.provider) ? current.provider as Record<string, unknown> : {};
  const chatgpt = provider["chatgpt-web"] && typeof provider["chatgpt-web"] === "object" && !Array.isArray(provider["chatgpt-web"]) ? provider["chatgpt-web"] as Record<string, unknown> : {};
  const options = chatgpt.options && typeof chatgpt.options === "object" && !Array.isArray(chatgpt.options) ? chatgpt.options as Record<string, unknown> : {};
  return {
    object: "chatgpt.admin.opencode", config_path: configPath, state_path: opencodeStatePath(),
    config_exists: fs.existsSync(configPath), state_exists: fs.existsSync(opencodeStatePath()), backup_exists: fs.existsSync(opencodeBackupPath(configPath)),
    injected: Object.keys(chatgpt).length > 0, model: current.model ?? null, base_url: options.baseURL ?? null, api_key: options.apiKey ? "<set>" : null,
    recommended: { base_url: config.publicBaseUrl, model: "chatgpt-web/auto@optimized" },
  };
}

async function injectOpencode(config: BridgeConfig, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const configPath = opencodeConfigPath(stringValue(body.config_path));
  const baseUrl = stringValue(body.base_url) ?? config.publicBaseUrl;
  const apiKey = stringValue(body.api_key) ?? config.apiKey ?? "local-dev-key";
  const model = stringValue(body.model) ?? "chatgpt-web/auto@optimized";
  const existing = readJsonFile(configPath);
  const backup = opencodeBackupPath(configPath);
  if (fs.existsSync(configPath) && !fs.existsSync(backup)) await fsPromises.copyFile(configPath, backup, fs.constants.COPYFILE_EXCL).catch(() => undefined);
  const provider = existing.provider && typeof existing.provider === "object" && !Array.isArray(existing.provider) ? { ...(existing.provider as Record<string, unknown>) } : {};
  const old = provider["chatgpt-web"] && typeof provider["chatgpt-web"] === "object" && !Array.isArray(provider["chatgpt-web"]) ? { ...(provider["chatgpt-web"] as Record<string, unknown>) } : {};
  const options = old.options && typeof old.options === "object" && !Array.isArray(old.options) ? { ...(old.options as Record<string, unknown>) } : {};
  provider["chatgpt-web"] = { ...old, options: { ...options, baseURL: baseUrl, apiKey } };
  const commands = existing.command && typeof existing.command === "object" && !Array.isArray(existing.command) ? { ...(existing.command as Record<string, unknown>) } : {};
  commands["chatgpt:usage"] = { template: "/chatgpt:usage", description: "Show ChatGPT Web account usage" };
  commands["chatgpt:research"] = { template: "Run ChatGPT Deep Research for: $ARGUMENTS", description: "Ask the local ChatGPT bridge to run research" };
  const merged = { ...existing, provider, command: commands, model, small_model: model };
  await writeJsonFile(configPath, merged);
  await writeJsonFile(opencodeStatePath(), { version: 1, updated_at: new Date().toISOString(), base_url: baseUrl, api_key: apiKey, model, config_path: configPath, source: "bridge-console" });
  return { ok: true, action: "inject", ...opencodeStatus(config, configPath) };
}

async function ejectOpencode(config: BridgeConfig, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const configPath = opencodeConfigPath(stringValue(body.config_path));
  const backup = opencodeBackupPath(configPath);
  if (fs.existsSync(backup)) {
    await fsPromises.copyFile(backup, configPath);
    return { ok: true, action: "restore-backup", config_path: configPath, backup_path: backup };
  }
  const existing = readJsonFile(configPath);
  const provider = existing.provider && typeof existing.provider === "object" && !Array.isArray(existing.provider) ? { ...(existing.provider as Record<string, unknown>) } : {};
  delete provider["chatgpt-web"];
  const command = existing.command && typeof existing.command === "object" && !Array.isArray(existing.command) ? { ...(existing.command as Record<string, unknown>) } : {};
  delete command["chatgpt:usage"]; delete command["chatgpt:research"]; delete command["chatgpt:remain"]; delete command["chatgpt:remaining"];
  const result: Record<string, unknown> = { ...existing, provider, command };
  for (const key of ["model", "small_model"]) if (typeof result[key] === "string" && (result[key] as string).startsWith("chatgpt-web/")) delete result[key];
  await writeJsonFile(configPath, result);
  return { ok: true, action: "eject", config_path: configPath, backup_path: backup };
}

async function checkAccounts(config: BridgeConfig, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requested = stringValue(body.account);
  const accounts = discoverAccounts({ accountsDir: config.accountsDir, accounts: config.accounts.length ? config.accounts : undefined, includeInvalidCaptures: true })
    .filter((item) => !requested || requested === "all" || requested === "*" || item.name === requested);
  const entries = await Promise.all(accounts.map(async (item) => {
    const status = item.name ? await new ChatGPTWebProvider(providerConfig(config, item.name)).status().catch((error) => ({ configured: false, source: item.name, error: error instanceof Error ? error.message : String(error) })) : { configured: false };
    return { account: item.name, ok: Boolean(item.exists && !item.error && status.configured), capture_exists: item.exists, status: status.configured ? "configured" : "not_configured", error: item.error ?? ("error" in status ? status.error : undefined), info: item.info?.toRedactedDict?.() ?? null, capabilities: item.capabilities ?? null, live_probe: false };
  }));
  return { object: "chatgpt.admin.account_check", generated_at: new Date().toISOString(), accounts: entries, note: "Checks local capture/settings only; no provider request was made." };
}

async function handleAdminPost(pathname: string, body: Record<string, unknown>, config: BridgeConfig, store: BridgeAdminStore): Promise<Record<string, unknown>> {
  if (pathname === "/v1/chatgpt/admin/captures/inspect") {
    const text = stringValue(body.capture_text) ?? stringValue(body.capture) ?? stringValue(body.text) ?? stringValue(body.request) ?? "";
    if (!text) throw new BridgeError("capture is required", 400, "invalid_request_error");
    return inspectCapture(text);
  }
  if (pathname === "/v1/chatgpt/admin/captures/save") {
    const account = validateAccountName(stringValue(body.account) ?? "");
    const text = stringValue(body.capture_text) ?? stringValue(body.capture) ?? stringValue(body.text) ?? stringValue(body.request);
    if (!text) throw new BridgeError("capture is required", 400, "invalid_request_error");
    const target = resolveAccountCapturePath(account, config.accountsDir);
    const key = body.encrypt === false ? undefined : loadSecretsKey(config.accountsDir);
    writeCaptureFile(target, text, key);
    const inspection = inspectCapture(text);
    if (body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)) await writeJsonFile(resolveAccountSettingsPath(account, config.accountsDir), body.settings as Record<string, unknown>);
    if (stringValue(body.settings_text)) {
      const parsed = parseJsonBody(stringValue(body.settings_text)!);
      await writeJsonFile(resolveAccountSettingsPath(account, config.accountsDir), parsed);
    }
    store.recordAccountCapture(account, target, inspection as never);
    return { object: "chatgpt.admin.capture_save", ok: true, account, capture_path: target, encrypted: Boolean(key), inspection };
  }
  if (pathname === "/v1/chatgpt/admin/accounts/check") return checkAccounts(config, body);
  if (pathname === "/v1/chatgpt/admin/accounts") return { object: "chatgpt.admin.accounts", accounts: discoverAccounts({ accountsDir: config.accountsDir, accounts: config.accounts.length ? config.accounts : undefined, includeInvalidCaptures: true }).map((item) => ({ account: item.name, configured: runtimeAccountNames(config).includes(item.name), capture_exists: item.exists, settings_exists: item.hasSettings, capture_path: item.capturePath, settings_path: item.settingsPath, info: item.info?.toRedactedDict?.() ?? null, capabilities: item.capabilities ?? null, error: item.error ?? null })) };
  if (pathname === "/v1/chatgpt/admin/accounts/delete") {
    const account = validateAccountName(stringValue(body.account) ?? "");
    const capture = resolveAccountCapturePath(account, config.accountsDir);
    const settings = resolveAccountSettingsPath(account, config.accountsDir);
    let deletedCapture = false; let deletedSettings = false;
    try { await fsPromises.unlink(capture); deletedCapture = true; } catch { /* absent */ }
    try { await fsPromises.unlink(settings); deletedSettings = true; } catch { /* absent */ }
    const stored = store.deleteAccountCapture(account);
    return { object: "chatgpt.admin.account_delete", ok: true, account, deleted: { capture: deletedCapture, settings: deletedSettings, stored_metadata: stored } };
  }
  if (pathname === "/v1/chatgpt/admin/settings/save") {
    const settings = body.settings && typeof body.settings === "object" && !Array.isArray(body.settings) ? body.settings : body;
    store.setSetting("bridge", settings);
    return { object: "chatgpt.admin.settings_save", ok: true, settings };
  }
  if (pathname === "/v1/chatgpt/admin/settings/reset") {
    store.deleteSetting("bridge");
    return { object: "chatgpt.admin.settings_reset", ok: true, settings: {} };
  }
  if (pathname === "/v1/chatgpt/admin/artifacts/delete") {
    const fileId = stringValue(body.file_id);
    if (!fileId) throw new BridgeError("file_id is required", 400, "invalid_request_error");
    const artifact = store.deleteArtifact(fileId);
    if (!artifact) throw new BridgeError("artifact was not found", 404, "not_found");
    let deletedFile = false;
    if (body.delete_file === true) { try { await fsPromises.unlink(artifact.path); deletedFile = true; } catch { /* absent */ } }
    return { object: "chatgpt.admin.artifact_delete", ok: true, file_id: fileId, deleted_file: deletedFile, artifact };
  }
  if (pathname === "/v1/chatgpt/admin/test/chat") {
    const started = Date.now();
    const prompt = stringValue(body.message) ?? stringValue(body.prompt) ?? "Say hello in one sentence.";
    const messages: ChatCompletionRequest["messages"] = [];
    const system = stringValue(body.system);
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    const result = await runChat(config, { model: stringValue(body.model) ?? "auto", messages, stream: false }, undefined);
    return { ok: true, latency_ms: Date.now() - started, content: result.text, response: openAIResponse({ messages }, result) };
  }
  if (pathname === "/v1/chatgpt/admin/test/image") {
    const prompt = stringValue(body.prompt);
    if (!prompt) throw new BridgeError("prompt is required", 400, "invalid_request_error");
    const started = Date.now();
    const imageBody = { ...body, response_format: "url" };
    const router = routerFor(config); const candidates: Array<string | undefined> = router ? [...router.order()] : [undefined];
    let lastError: unknown;
    for (const account of candidates) {
      try {
        const provider = new ChatGPTWebProvider(providerConfig(config, account));
        const response = account && router ? await router.concurrency.run(account, () => provider.generateImage(prompt, [], stringValue(body.model) ?? "auto")) : await provider.generateImage(prompt, [], stringValue(body.model) ?? "auto");
        return { ok: true, latency_ms: Date.now() - started, response: await saveImageResponse(config, response, imageBody, account, store) };
      } catch (error) { lastError = error; if (!retryableProviderError(error) || account === candidates[candidates.length - 1]) throw error; }
    }
    throw lastError ?? new ProviderError("No ChatGPT accounts are configured");
  }
  if (pathname === "/v1/chatgpt/admin/opencode/inject") return injectOpencode(config, body);
  if (pathname === "/v1/chatgpt/admin/opencode/eject") return ejectOpencode(config, body);
  throw new BridgeError(`unknown admin route: ${pathname}`, 404, "not_found");
}

export function createBridgeServer(config: BridgeConfig): http.Server {
  const store = new BridgeAdminStore(config.adminDbPath);
  return http.createServer(async (req, res) => {
    withCors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (!authorize(req, config)) { json(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } }); return; }
      const fileMatch = url.pathname.match(/^\/v1\/chatgpt\/files\/([^/]+)(?:\/.*)?$/);
      if ((req.method === "GET" || req.method === "HEAD") && fileMatch?.[1]) { await serveArtifact(req, res, store, fileMatch[1]); return; }
      if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/admin" || url.pathname === "/admin/")) { res.writeHead(302, { location: config.consoleUrl }); res.end(); return; }
      if (req.method === "GET" && url.pathname === "/health") { json(res, 200, { ok: true, provider: await new ChatGPTWebProvider(config).status(), artifact_downloads: { route: "/v1/chatgpt/files/{id}/{filename}", public_base_url: config.publicBaseUrl } }); return; }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const ids = ["chatgpt-web/auto", "chatgpt-web", "auto", "chatgpt-deep-research", "gpt-5-5", "gpt-5-5-thinking", "gpt-5-5-thinking-medium", "gpt-5-5-thinking-high", "gpt-5-5-thinking-xhigh", "gpt-5-5-pro", "gpt-5-5-pro-medium", "gpt-5-5-pro-high", "gpt-5-5-pro-xhigh"];
        json(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "chatgpt-web" })) }); return;
      }
      const operationMatch = url.pathname.match(/^\/v1\/chatgpt\/operations\/([^/]+)$/);
      if (req.method === "GET" && operationMatch?.[1]) { const payload = defaultOperationRegistry.payload(operationMatch[1]); if (!payload) { json(res, 404, { error: { message: "operation not found", type: "not_found" } }); return; } json(res, 200, { object: "chatgpt.operation", operation: payload }); return; }
      const cancelMatch = url.pathname.match(/^\/v1\/chatgpt\/operations\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch?.[1]) { const operation = await defaultOperationRegistry.cancelAsync(cancelMatch[1]); if (!operation) { json(res, 404, { error: { message: "operation not found", type: "not_found" } }); return; } json(res, 200, { object: "chatgpt.operation.cancel", operation: defaultOperationRegistry.payload(operation.id) }); return; }
      if (req.method === "GET" && url.pathname === "/v1/chatgpt/admin/status") { json(res, 200, adminStatus(config, store)); return; }
      if (req.method === "GET" && url.pathname === "/v1/chatgpt/admin/accounts") { json(res, 200, await handleAdminPost(url.pathname, {}, config, store)); return; }
      if (req.method === "GET" && url.pathname === "/v1/chatgpt/admin/artifacts") { json(res, 200, { object: "chatgpt.admin.artifacts", artifacts: store.listArtifacts(Number(url.searchParams.get("limit") ?? "100")) }); return; }
      if (req.method === "GET" && url.pathname === "/v1/chatgpt/admin/settings") { json(res, 200, { object: "chatgpt.admin.settings", settings: store.getSetting("bridge", {}) }); return; }
      if (req.method === "GET" && url.pathname === "/v1/chatgpt/admin/opencode") { json(res, 200, opencodeStatus(config)); return; }
      if (req.method === "GET" && ["/v1/chatgpt/usage", "/v1/chatgpt/remaining", "/v1/chatgpt/usage/live"].includes(url.pathname)) {
        const accounts = discoverAccounts({ accountsDir: config.accountsDir, accounts: config.accounts.length ? config.accounts : undefined, includeInvalidCaptures: true }).map((item) => ({ account: item.name, configured: item.exists && !item.error, plan_type: item.info?.planType ?? null, plan_bucket: item.info?.planBucket ?? null, capabilities: item.capabilities ?? null, live: false, error: item.error ?? null }));
        json(res, 200, { object: "chatgpt.usage", supported: false, accounts, note: "This Node port reports capture-derived capabilities. Live provider quota probing is not available without a stable ChatGPT Web quota endpoint." }); return;
      }
      if (req.method === "POST") {
        const body = parseJsonBody(await readBody(req, config.maxBodyBytes));
        if (url.pathname.startsWith("/v1/chatgpt/admin/")) { json(res, 200, await handleAdminPost(url.pathname, body, config, store)); return; }
        if (url.pathname === "/v1/chat/completions") {
          if (!Array.isArray(body.messages)) throw new BridgeError("messages must be a list", 400, "invalid_request_error");
          const request = body as unknown as ChatCompletionRequest;
          const requestConfig = configForRequest(config, body);
          const requestedOperation = operationIdFrom(body, req);
          const research = isResearchRequest(request);
          const operation = request.stream === true || requestedOperation || research ? createOperation(research ? "research" : "chat", requestedOperation) : undefined;
          try {
            if (request.stream === true) { await sendChatStream(res, requestConfig, request, operation ?? createOperation("chat")); return; }
            const result = research ? await runResearch(requestConfig, request, operation, store) : await runChat(requestConfig, request, operation);
            json(res, 200, openAIResponse(request, result, operation));
          } finally { if (operation && !operation.completed && operation.status !== "failed") defaultOperationRegistry.complete(operation.id); }
          return;
        }
        if (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits") {
          const prompt = stringValue(body.prompt);
          if (!prompt) throw new BridgeError("prompt must be a non-empty string", 400, "invalid_request_error");
          if (body.n !== undefined && body.n !== 1) throw new BridgeError("only n=1 is currently supported", 400, "invalid_request_error");
          const requestConfig = configForRequest(config, body);
          const images = url.pathname.endsWith("/edits") ? await imageInputsFromBody(body, true) : [];
          const router = routerFor(requestConfig); const candidates: Array<string | undefined> = router ? [...router.order()] : [undefined];
          let lastError: unknown;
          for (const account of candidates) {
            try {
              const provider = new ChatGPTWebProvider(providerConfig(requestConfig, account));
              const response = account && router ? await router.concurrency.run(account, () => provider.generateImage(prompt, images, stringValue(body.model) ?? "auto")) : await provider.generateImage(prompt, images, stringValue(body.model) ?? "auto");
              json(res, 200, await saveImageResponse(requestConfig, response, body, account, store));
              lastError = undefined; break;
            } catch (error) { lastError = error; if (!retryableProviderError(error) || account === candidates[candidates.length - 1]) throw error; }
          }
          if (lastError) throw lastError;
          return;
        }
        if (url.pathname === "/v1/chatgpt/vision") {
          const requestConfig = configForRequest(config, body);
          const images = await imageInputsFromBody(body, true);
          const prompt = stringValue(body.prompt) ?? (stringValue(body.mode) === "ocr" ? "Extract visible text from the image." : "Describe the image in detail.");
          const result = await runVision(requestConfig, prompt, images, stringValue(body.model) ?? "auto");
          json(res, 200, { object: "chatgpt.vision", text: result.text, mode: stringValue(body.mode) ?? "custom", input_image_count: images.length, chatgpt_account: result.account ?? null });
          return;
        }
      }
      json(res, 404, { error: { message: "Route not found", type: "not_found" } });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error instanceof BridgeError ? error.statusCode : 500, errorPayload(error));
    }
  });
}

async function runVision(config: BridgeConfig, prompt: string, images: import("./types.js").ImageInput[], model: string): Promise<{ text: string; account?: string }> {
  const router = routerFor(config); const candidates: Array<string | undefined> = router ? [...router.order()] : [undefined];
  let lastError: unknown;
  for (const account of candidates) {
    try {
      const provider = new ChatGPTWebProvider(providerConfig(config, account));
      const text = account && router ? await router.concurrency.run(account, () => provider.vision(prompt, images, model)) : await provider.vision(prompt, images, model);
      if (account) router?.markSuccess(account);
      return { text, account };
    } catch (error) { lastError = error; if (account) router?.markFailure(account); if (!retryableProviderError(error) || account === candidates[candidates.length - 1]) throw error; }
  }
  throw lastError ?? new ProviderError("No ChatGPT accounts are configured");
}
