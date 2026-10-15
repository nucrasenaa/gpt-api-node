import { randomUUID } from "node:crypto";
import { loadAuth, type AuthConfig } from "../auth/request-capture.js";
import type { BridgeConfig } from "../config.js";
import { ProviderError, ProviderNotConfiguredError } from "../errors.js";
import { buildChatGPTPayload, conversationHeaders, jsonHeadersForTokenRefresh, markPayloadSentAfterPrepare, prepareChatGPTPayload } from "./transport/chatgpt-payload.js";
import { ChatGPTEndpoints, conversationEndpoint } from "./transport/endpoints.js";
import { normalizeEventDelta, type ProviderEvent } from "./transport/deltas.js";
import { parseJsonSseStream } from "./transport/sse.js";
import { decodeProofConfig, generateProofToken } from "./transport/proof.js";
import type { ChatCompletionRequest, ChatDelta, ImageInput, ImageResponse, ProviderStatus } from "../types.js";

interface UploadedFile {
  file_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
}

function endpointFromCapture(auth: AuthConfig, config: BridgeConfig): string {
  if (auth.capturedUrl) return auth.capturedUrl.replace(/\/backend-api\/f\/conversation\/prepare\/?$/, "/backend-api/f/conversation");
  return conversationEndpoint(config.chatgptBaseUrl);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function pointerValues(value: unknown): string[] {
  const found: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/(?:file-service|sediment):\/\/[\w.-]+/g)) if (match[0] && !found.includes(match[0])) found.push(match[0]);
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") {
      const current = item as Record<string, unknown>;
      if (current.content_type === "image_asset_pointer" && typeof current.asset_pointer === "string" && !found.includes(current.asset_pointer)) found.push(current.asset_pointer);
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return found;
}

function conversationIdFromEvents(events: ProviderEvent[]): string | undefined {
  for (const event of events) {
    const id = stringValue(event.conversation_id) ?? stringValue(event.conversationId);
    if (id) return id;
  }
  return undefined;
}

function providerModel(model: string | undefined): string {
  const normalized = (model ?? "auto").replace(/^chatgpt-web\//i, "").split("@", 1)[0] ?? "auto";
  if (normalized === "chatgpt-deep-research" || normalized === "deep-research") return "auto";
  return normalized || "auto";
}

export class ChatGPTWebProvider {
  private auth?: AuthConfig;
  private refreshedAt = 0;

  constructor(private readonly config: BridgeConfig) {}

  async status(): Promise<ProviderStatus> {
    this.auth ??= await loadAuth(this.config);
    return { configured: Boolean(this.auth.accessToken || this.auth.headers.authorization || Object.keys(this.auth.cookies).length), source: this.auth.source, account: this.config.account };
  }

  async *streamChat(request: ChatCompletionRequest, inputImages: ImageInput[] = [], options: ProviderRequestOptions = {}): AsyncGenerator<ChatDelta> {
    await this.loadAndEnsureAuth();
    const uploadedFiles = inputImages.length ? await this.uploadFiles(inputImages, options) : [];
    const metadata = request.metadata && typeof request.metadata === "object" && !Array.isArray(request.metadata) ? request.metadata as Record<string, unknown> : {};
    const transportRequest = {
      ...request,
      model: providerModel(request.model),
      action: typeof request.action === "string" ? request.action : "next",
      conversationId: typeof request.conversation_id === "string" ? request.conversation_id : undefined,
      parentMessageId: typeof request.parent_message_id === "string" ? request.parent_message_id : undefined,
      thinkingEffort: typeof request.thinking_effort === "string" ? request.thinking_effort : undefined,
      metadata: { ...metadata, captured_request_json: this.auth?.capturedRequestJson, history_and_training_disabled: this.config.temporaryChat },
    };
    const payload = buildChatGPTPayload(transportRequest, { capturedRequestJson: this.auth?.capturedRequestJson, idFactory: randomUUID });
    payload.messages = this.providerMessages(request.messages, uploadedFiles);
    payload.history_and_training_disabled = this.config.temporaryChat;
    if (request.tools !== undefined) payload.tools = request.tools;
    if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
    if (typeof request.conversation_id === "string") payload.conversation_id = request.conversation_id;

    const state = { lastText: "" };
    for await (const event of this.postEventStream(payload, options)) {
      const raw = record(event);
      const error = record(raw.error);
      const errorMessage = stringValue(error.message);
      if (errorMessage) throw new ProviderError(errorMessage);
      const normalized = normalizeEventDelta(raw, state);
      if (!normalized) continue;
      if (normalized.text || normalized.conversationId) yield { text: normalized.text, conversationId: normalized.conversationId, raw: normalized.raw };
    }
  }

  async generateImage(prompt: string, inputImages: ImageInput[] = [], model = "auto", options: ProviderRequestOptions = {}): Promise<ImageResponse> {
    await this.loadAndEnsureAuth();
    const uploadedFiles = inputImages.length ? await this.uploadFiles(inputImages, options) : [];
    const template = this.auth?.capturedRequestJson ?? {};
    const payload: Record<string, unknown> = {
      ...template, action: "next", model: providerModel(model), parent_message_id: randomUUID(), client_prepare_state: "success",
      system_hints: Array.from(new Set([...(Array.isArray(template.system_hints) ? template.system_hints.filter((item): item is string => typeof item === "string") : []), "picture_v2"])),
      conversation_mode: template.conversation_mode ?? { kind: "primary_assistant" }, timezone_offset_min: new Date().getTimezoneOffset(),
      messages: [{ id: randomUUID(), author: { role: "user" }, create_time: Date.now() / 1000,
        content: { content_type: uploadedFiles.length ? "multimodal_text" : "text", parts: [...uploadedFiles.map((file) => ({ asset_pointer: `file-service://${file.file_id}`, size_bytes: file.file_size })), prompt] },
        metadata: uploadedFiles.length ? { attachments: uploadedFiles.map((file) => ({ id: file.file_id, mimeType: file.mime_type, name: file.file_name, size: file.file_size })) } : {},
      }],
    };
    const events = await this.postEventList(payload, options);
    const conversationId = conversationIdFromEvents(events);
    const excluded = new Set(uploadedFiles.flatMap((file) => [`file-service://${file.file_id}`, `sediment://${file.file_id}`]));
    let pointers = pointerValues(events).filter((value) => !excluded.has(value));
    if (!pointers.length && conversationId) pointers = await this.pollGeneratedAssets(conversationId, excluded, options);
    const images: ImageResponse["images"] = [];
    for (const pointer of pointers.slice(0, 1)) images.push(await this.downloadAsset(pointer, conversationId, options));
    if (!images.length) throw new ProviderError("ChatGPT image generation returned no image asset");
    return { prompt, images, raw: { events, assets: pointers, conversationId } };
  }

  async vision(prompt: string, inputImages: ImageInput[], model = "auto", options: ProviderRequestOptions = {}): Promise<string> {
    const request: ChatCompletionRequest = { model, messages: [{ role: "user", content: prompt }], stream: true };
    let text = "";
    for await (const delta of this.streamChat(request, inputImages, options)) text += delta.text;
    return text.trim();
  }

  async conversationInit(requestedDefaultModel = "auto", conversationId?: string, options: ProviderRequestOptions = {}): Promise<Record<string, unknown>> {
    await this.loadAndEnsureAuth();
    const headers = await this.refreshHeaders({ action: "next", model: requestedDefaultModel }, options);
    const endpoint = new ChatGPTEndpoints({ baseUrl: this.config.chatgptBaseUrl }).conversationInitUrl;
    return this.fetchJson(endpoint, { method: "POST", headers: { ...jsonHeadersForTokenRefresh(headers), "content-type": "application/json" }, body: JSON.stringify({ requested_default_model: requestedDefaultModel, conversation_id: conversationId ?? null, timezone_offset_min: new Date().getTimezoneOffset() }) }, options);
  }

  async stopConversation(conversationId: string, options: ProviderRequestOptions = {}): Promise<Record<string, unknown>> {
    await this.loadAndEnsureAuth();
    const endpoint = new ChatGPTEndpoints({ baseUrl: this.config.chatgptBaseUrl }).stopConversationUrl;
    return this.fetchJson(endpoint, { method: "POST", headers: { ...jsonHeadersForTokenRefresh(this.authHeaders()), "content-type": "application/json" }, body: JSON.stringify({ conversation_id: conversationId }) }, options);
  }

  private async loadAndEnsureAuth(): Promise<void> { this.auth ??= await loadAuth(this.config); this.ensureConfigured(); }

  private ensureConfigured(): void {
    if (!this.auth?.accessToken && !this.auth?.headers.authorization && !Object.keys(this.auth?.cookies ?? {}).length) throw new ProviderNotConfiguredError("ChatGPT access token is missing. Set CHATGPT_ACCESS_TOKEN or CHATGPT_REQUEST_PATH.");
  }

  private providerMessages(messages: ChatCompletionRequest["messages"], uploadedFiles: UploadedFile[]): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    let uploadIndex = 0;
    for (const message of messages) {
      const parts: unknown[] = [];
      const attachments: UploadedFile[] = [];
      let hasMedia = false;
      if (typeof message.content === "string") parts.push(message.content);
      else for (const part of message.content) {
        if (part.type === "text") parts.push(part.text ?? "");
        else if (part.type === "image_url" && part.image_url?.url) {
          hasMedia = true;
          const file = uploadedFiles[uploadIndex++];
          if (file) { attachments.push(file); parts.push({ asset_pointer: `file-service://${file.file_id}`, size_bytes: file.file_size }); }
          else parts.push({ type: "image_url", image_url: part.image_url.url });
        }
      }
      result.push({ id: randomUUID(), author: { role: message.role }, create_time: Date.now() / 1000, content: { content_type: hasMedia ? "multimodal_text" : "text", parts }, metadata: attachments.length ? { attachments: attachments.map((file) => ({ id: file.file_id, mimeType: file.mime_type, name: file.file_name, size: file.file_size })) } : {} });
    }
    return result;
  }

  private async uploadFiles(images: ImageInput[], options: ProviderRequestOptions): Promise<UploadedFile[]> {
    const uploaded: UploadedFile[] = [];
    for (const image of images) uploaded.push(await this.uploadFile(image, options));
    return uploaded;
  }

  private async uploadFile(image: ImageInput, options: ProviderRequestOptions): Promise<UploadedFile> {
    const base = this.config.chatgptBaseUrl.replace(/\/$/, "");
    const headers = this.authHeaders();
    const fileName = image.name ?? `file-${image.data.byteLength}.png`;
    const created = await this.fetchJson(`${base}/backend-api/files`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ file_name: fileName, file_size: image.data.byteLength, use_case: "multimodal" }) }, options);
    const uploadUrl = stringValue(created.upload_url);
    const fileId = stringValue(created.file_id);
    if (!uploadUrl || !fileId) throw new ProviderError("ChatGPT file create response did not include upload_url and file_id");
    const upload = await this.fetchWithTimeout(uploadUrl, { method: "PUT", headers: { "content-type": image.mimeType, "x-ms-blob-type": "BlockBlob", "x-ms-version": "2020-04-08" }, body: new Uint8Array(image.data) }, options.signal);
    if (!upload.ok) throw new ProviderError(`ChatGPT file upload failed: ${upload.status}`);
    const completed = await this.fetchJson(`${base}/backend-api/files/${encodeURIComponent(fileId)}/uploaded`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }, options);
    return { ...created, ...completed, file_id: fileId, file_name: fileName, file_size: image.data.byteLength, mime_type: image.mimeType } as UploadedFile;
  }

  private async *postEventStream(payload: Record<string, unknown>, options: ProviderRequestOptions = {}): AsyncGenerator<ProviderEvent> {
    const headers = await this.refreshHeaders(payload, options);
    markPayloadSentAfterPrepare(payload);
    const response = await this.fetchWithTimeout(endpointFromCapture(this.auth!, this.config), { method: "POST", headers: conversationHeaders(headers), body: JSON.stringify(payload) }, options.signal);
    if (!response.ok) throw new ProviderError(`ChatGPT conversation failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
    if (!response.body) throw new ProviderError("ChatGPT Web returned an empty response");
    yield* parseJsonSseStream(response.body);
  }

  private async postEventList(payload: Record<string, unknown>, options: ProviderRequestOptions): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const event of this.postEventStream(payload, options)) events.push(event);
    return events;
  }

  private async refreshHeaders(payload: Record<string, unknown>, options: ProviderRequestOptions): Promise<Record<string, string>> {
    const current = this.authHeaders();
    if (!this.config.refreshWebTokens || Date.now() - this.refreshedAt < 5_000) return current;
    const endpoints = new ChatGPTEndpoints({ baseUrl: this.config.chatgptBaseUrl });
    const prepare = await this.fetchJson(endpoints.prepareUrl, { method: "POST", headers: jsonHeadersForTokenRefresh(current), body: JSON.stringify(prepareChatGPTPayload(payload)) }, options);
    const conduit = stringValue(prepare.conduit_token) ?? stringValue(prepare.token);
    if (conduit) this.auth!.headers["x-conduit-token"] = conduit;

    // Sentinel has its own request contract. It does not accept the web
    // conversation target headers or the previous sentinel tokens; the
    // browser first prepares a challenge and then finalizes it.
    const makeSentinelHeaders = (): Record<string, string> => {
      const headers = jsonHeadersForTokenRefresh(this.authHeaders());
      for (const name of [
        "x-conduit-token", "x-openai-target-path", "x-openai-target-route",
        "x-openai-sentinel-prepare-p",
        "openai-sentinel-chat-requirements-token", "openai-sentinel-proof-token",
        "openai-sentinel-turnstile-token",
      ]) delete headers[name];
      return headers;
    };

    const requirements = await this.fetchJson(
      endpoints.requirementsUrl,
      { method: "POST", headers: makeSentinelHeaders(), body: JSON.stringify({ p: current["x-openai-sentinel-prepare-p"] ?? null }) },
      options,
    );
    const challenge = record(requirements.proofofwork);
    const userAgent = current["user-agent"] ?? this.config.userAgent;
    const proof = challenge.required
      ? generateProofToken(true, stringValue(challenge.seed) ?? "", stringValue(challenge.difficulty) ?? "", userAgent, decodeProofConfig(current["openai-sentinel-proof-token"]))
      : undefined;
    const prepareToken = stringValue(requirements.prepare_token) ?? stringValue(requirements.token);
    const immediateToken = stringValue(requirements.token);
    let finalized: Record<string, any> = {};
    if (!immediateToken) {
      const turnstile = stringValue(current["openai-sentinel-turnstile-token"]);
      if (record(requirements.turnstile).required && !turnstile) {
        throw new ProviderError("ChatGPT sentinel requires a fresh openai-sentinel-turnstile-token; capture a new browser request");
      }
      if (!prepareToken) throw new ProviderError("ChatGPT sentinel prepare response did not include a token");
      finalized = await this.fetchJson(
        `${endpoints.requirementsUrl}/finalize`,
        {
          method: "POST",
          headers: makeSentinelHeaders(),
          body: JSON.stringify({
            prepare_token: prepareToken,
            ...(proof ? { proofofwork: proof } : {}),
            ...(turnstile ? { turnstile } : {}),
          }),
        },
        options,
      );
    }

    const refreshed: Record<string, string> = { ...this.authHeaders() };
    const requirementsToken = immediateToken ?? stringValue(finalized.token) ?? prepareToken;
    if (requirementsToken) refreshed["openai-sentinel-chat-requirements-token"] = requirementsToken;
    if (challenge.required) {
      if (proof) refreshed["openai-sentinel-proof-token"] = proof;
    }
    this.auth!.headers = { ...this.auth!.headers, ...refreshed };
    this.refreshedAt = Date.now();
    return refreshed;
  }

  private async fetchJson(url: string, init: RequestInit, options: ProviderRequestOptions = {}): Promise<Record<string, any>> {
    const response = await this.fetchWithTimeout(url, init, options.signal);
    this.captureSetCookies(response);
    const text = (await response.text()).slice(0, 4_000_000);
    let payload: unknown = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
      throw new ProviderError(`ChatGPT request failed: ${path} ${response.status} ${text.slice(0, 500)}`);
    }
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, any> : {};
  }

  private captureSetCookies(response: Response): void {
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
    if (!setCookies.length || !this.auth) return;
    for (const setCookie of setCookies) {
      const first = setCookie.split(";", 1)[0] ?? "";
      const separator = first.indexOf("=");
      if (separator <= 0) continue;
      const name = first.slice(0, separator).trim();
      const value = first.slice(separator + 1).trim().replace(/^"|"$/g, "");
      if (name) this.auth.cookies[name] = value;
    }
    this.auth.headers.cookie = Object.entries(this.auth.cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private async fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("ChatGPT Web request timed out")), this.config.webTimeoutMs);
    const abort = () => controller.abort(signal?.reason ?? new Error("ChatGPT Web request cancelled"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    try {
      return await fetch(url, { ...init, signal: controller.signal, headers: { "user-agent": this.config.userAgent, ...(init.headers ?? {}) } });
    } catch (error) {
      if (signal?.aborted) throw new ProviderError("ChatGPT request was cancelled", 499);
      if (controller.signal.aborted) throw new ProviderError("ChatGPT request timed out", 504);
      throw new ProviderError(error instanceof Error ? `ChatGPT network request failed: ${error.message}` : "ChatGPT network request failed", 502);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...(this.auth?.headers ?? {}) };
    if (this.auth?.accessToken && !headers.authorization) headers.authorization = `Bearer ${this.auth.accessToken}`;
    if (this.auth?.cookies && !headers.cookie) headers.cookie = Object.entries(this.auth.cookies).map(([key, value]) => `${key}=${value}`).join("; ");
    headers["user-agent"] ??= this.config.userAgent;
    return headers;
  }

  private async pollGeneratedAssets(conversationId: string, excluded: Set<string>, options: ProviderRequestOptions): Promise<string[]> {
    const deadline = Date.now() + Math.min(this.config.webTimeoutMs, 60_000);
    const base = this.config.chatgptBaseUrl.replace(/\/$/, "");
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new ProviderError("ChatGPT image generation was cancelled", 499);
      const value = await this.fetchJson(`${base}/backend-api/conversation/${encodeURIComponent(conversationId)}`, { headers: jsonHeadersForTokenRefresh(this.authHeaders()) }, options);
      const pointers = pointerValues(value).filter((pointer) => !excluded.has(pointer));
      if (pointers.length) return pointers;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    return [];
  }

  private async downloadAsset(pointer: string, conversationId: string | undefined, options: ProviderRequestOptions): Promise<{ data: Buffer; url?: string; mimeType?: string; raw: unknown }> {
    const [scheme, assetId] = pointer.split("://", 2);
    if (!assetId) throw new ProviderError("invalid image asset pointer");
    const base = this.config.chatgptBaseUrl.replace(/\/$/, "");
    const metadataUrl = scheme === "sediment" ? `${base}/backend-api/files/download/${encodeURIComponent(assetId)}?conversation_id=${encodeURIComponent(conversationId ?? "")}&inline=false` : `${base}/backend-api/files/${encodeURIComponent(assetId)}/download`;
    const metadata = await this.fetchJson(metadataUrl, { headers: jsonHeadersForTokenRefresh(this.authHeaders()) }, options);
    const downloadUrl = stringValue(metadata.download_url);
    if (!downloadUrl) throw new ProviderError("ChatGPT image metadata response did not include download_url");
    const image = await this.fetchWithTimeout(downloadUrl, { headers: { authorization: this.authHeaders().authorization ?? "", cookie: this.authHeaders().cookie ?? "", accept: "image/*,*/*;q=0.8" } }, options.signal);
    if (!image.ok) throw new ProviderError(`ChatGPT generated image download failed: ${image.status}`);
    return { data: Buffer.from(await image.arrayBuffer()), url: downloadUrl, mimeType: image.headers.get("content-type") ?? undefined, raw: { pointer, metadataUrl } };
  }
}
