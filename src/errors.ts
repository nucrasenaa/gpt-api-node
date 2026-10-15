export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly type = "server_error",
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export class ProviderNotConfiguredError extends BridgeError {
  constructor(message = "ChatGPT Web provider is not configured") {
    super(message, 503, "provider_not_configured");
  }
}

export class ProviderError extends BridgeError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode, "provider_error");
  }
}
