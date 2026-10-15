import { randomUUID } from "node:crypto";
import { loadAuth, type AuthConfig } from "../auth/request-capture.js";
import type { BridgeConfig } from "../config.js";
import { ProviderError, ProviderNotConfiguredError } from "../errors.js";
import type { ChatCompletionRequest, ChatDelta, ProviderStatus } from "../types.js";

interface ProviderEvent {
  message?: { content?: { parts?: unknown[] } };
  conversation_id?: string;
  conversationId?: string;
  error?: { message?: string };
  [key: string]: unknown;
}

function textFromEvent(event: ProviderEvent): string {
  const parts = event.message?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((part): part is string => typeof part === "string").join("");
}

function endpointFromCapture(auth: AuthConfig, config: BridgeConfig): string {
  if (auth.capturedUrl) return auth.capturedUrl;
  return `${config.chatgptBaseUrl.replace(/\/$/, "")}/backend-api/f/conversation`;
}

function messagesToText(messages: ChatCompletionRequest["messages"]): string {
  return messages.map((message) => {
    if (typeof message.content === "string") return `${message.role}: ${message.content}`;
    return `${message.role}: ${message.content.map((part) => part.text ?? "").join(" ")}`;
  }).join("\n");
}

export class ChatGPTWebProvider {
  private auth?: AuthConfig;

  constructor(private readonly config: BridgeConfig) {}

  async status(): Promise<ProviderStatus> {
    this.auth ??= await loadAuth(this.config);
    return {
      configured: Boolean(
        this.auth.accessToken
        || this.auth.headers.authorization
        || Object.keys(this.auth.cookies).length > 0,
      ),
      source: this.auth.source,
      account: this.config.account,
    };
  }

  async *streamChat(request: ChatCompletionRequest): AsyncGenerator<ChatDelta> {
    this.auth ??= await loadAuth(this.config);
    if (!this.auth.accessToken && !this.auth.headers.authorization) {
      throw new ProviderNotConfiguredError(
        "ChatGPT access token is missing. Set CHATGPT_ACCESS_TOKEN or CHATGPT_REQUEST_PATH.",
      );
    }

    const template = this.auth.capturedRequestJson ?? {};
    const payload: Record<string, unknown> = {
      ...template,
      action: "next",
      model: request.model ?? template.model ?? "auto",
      parent_message_id: randomUUID(),
      messages: [{
        id: randomUUID(),
        author: { role: "user" },
        content: { content_type: "text", parts: [messagesToText(request.messages)] },
      }],
      timezone_offset_min: new Date().getTimezoneOffset(),
      history_and_training_disabled: true,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.webTimeoutMs);
    try {
      const response = await fetch(endpointFromCapture(this.auth, this.config), {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...this.auth.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        throw new ProviderError(`ChatGPT Web request failed: ${response.status} ${body}`, response.status >= 400 && response.status < 500 ? 400 : 502);
      }
      if (!response.body) throw new ProviderError("ChatGPT Web returned an empty response");
      yield* this.parseEventStream(response.body);
    } catch (error) {
      if (error instanceof ProviderError || error instanceof ProviderNotConfiguredError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("ChatGPT Web request timed out", 504);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async *parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatDelta> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastText = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const line = event.split(/\r?\n/).find((item) => item.startsWith("data:"));
        if (!line) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let parsed: ProviderEvent;
        try {
          parsed = JSON.parse(raw) as ProviderEvent;
        } catch {
          continue;
        }
        if (parsed.error?.message) throw new ProviderError(parsed.error.message);
        const fullText = textFromEvent(parsed);
        const delta = fullText.startsWith(lastText) ? fullText.slice(lastText.length) : fullText;
        lastText = fullText;
        if (delta) yield { text: delta, conversationId: parsed.conversation_id ?? parsed.conversationId, raw: parsed };
      }
    }
  }
}
