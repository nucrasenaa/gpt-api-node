export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface ChatDelta {
  text: string;
  conversationId?: string;
  raw?: unknown;
}

export interface ImageInput {
  data: Buffer;
  mimeType: string;
  name?: string;
}

export interface ImageAsset {
  data?: Buffer;
  url?: string;
  mimeType?: string;
  raw?: unknown;
}

export interface ImageResponse {
  prompt: string;
  images: ImageAsset[];
  raw?: unknown;
}

export interface ProviderStatus {
  configured: boolean;
  source?: string;
  account?: string;
}
