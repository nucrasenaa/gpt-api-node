/** ChatGPT Web endpoint constants. No proof, image, or research calls are implied. */

export const CHATGPT_BASE_URL = "https://chatgpt.com";
export const CHATGPT_CONVERSATION_INIT_PATH = "/backend-api/conversation/init";
export const CHATGPT_CONVERSATION_PATH = "/backend-api/f/conversation";
export const CHATGPT_CONVERSATION_PREPARE_PATH = "/backend-api/f/conversation/prepare";
export const CHATGPT_CHAT_REQUIREMENTS_PATH = "/backend-api/sentinel/chat-requirements";
export const CHATGPT_STOP_CONVERSATION_PATH = "/backend-api/stop_conversation";
export const CHATGPT_CALL_MCP_PATH = "/backend-api/ecosystem/call_mcp";
export const CHATGPT_WEBSOCKET_PATH = "/backend-api/celsius/ws/user";

export interface ChatGPTEndpointsInit {
  baseUrl?: string;
  conversationInitUrl?: string;
  conversationUrl?: string;
  prepareUrl?: string;
  requirementsUrl?: string;
  stopConversationUrl?: string;
  callMcpUrl?: string;
  websocketUrl?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export class ChatGPTEndpoints {
  readonly baseUrl: string;
  readonly conversationInitUrl: string;
  readonly conversationUrl: string;
  readonly prepareUrl: string;
  readonly requirementsUrl: string;
  readonly stopConversationUrl: string;
  readonly callMcpUrl: string;
  readonly websocketUrl: string;

  constructor(init: ChatGPTEndpointsInit = {}) {
    this.baseUrl = (init.baseUrl ?? CHATGPT_BASE_URL).replace(/\/$/, "");
    this.conversationInitUrl = init.conversationInitUrl ?? joinUrl(this.baseUrl, CHATGPT_CONVERSATION_INIT_PATH);
    this.conversationUrl = init.conversationUrl ?? joinUrl(this.baseUrl, CHATGPT_CONVERSATION_PATH);
    this.prepareUrl = init.prepareUrl ?? joinUrl(this.baseUrl, CHATGPT_CONVERSATION_PREPARE_PATH);
    this.requirementsUrl = init.requirementsUrl ?? joinUrl(this.baseUrl, CHATGPT_CHAT_REQUIREMENTS_PATH);
    this.stopConversationUrl = init.stopConversationUrl ?? joinUrl(this.baseUrl, CHATGPT_STOP_CONVERSATION_PATH);
    this.callMcpUrl = init.callMcpUrl ?? joinUrl(this.baseUrl, CHATGPT_CALL_MCP_PATH);
    this.websocketUrl = init.websocketUrl ?? joinUrl(this.baseUrl, CHATGPT_WEBSOCKET_PATH);
  }

  streamStatusUrl(conversationId: string): string {
    return joinUrl(this.baseUrl, `/backend-api/conversation/${conversationId}/stream_status`);
  }
}

export const DEFAULT_CHATGPT_ENDPOINTS = new ChatGPTEndpoints();

export function conversationEndpoint(baseUrl = CHATGPT_BASE_URL, capturedUrl?: string): string {
  return capturedUrl ?? joinUrl(baseUrl, CHATGPT_CONVERSATION_PATH);
}
