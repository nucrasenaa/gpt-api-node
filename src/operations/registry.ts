import { randomUUID } from "node:crypto";

export type OperationStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

export interface OperationRecord {
  readonly id: string;
  readonly operationId: string;
  readonly kind: string;
  readonly createdAt: number;
  account?: string;
  provider?: unknown;
  conversationId?: string;
  deepResearchMessageId?: string;
  deepResearchSessionId?: string;
  cancelRequested: boolean;
  completed: boolean;
  status: OperationStatus;
  lastCancelResult?: Record<string, unknown>;
  lastCancelError?: string;
  error?: string;
  readonly signal: AbortSignal;
}

export type OperationUpdate = Partial<Pick<OperationRecord, "account" | "provider" | "conversationId" | "deepResearchMessageId" | "deepResearchSessionId" | "lastCancelResult" | "lastCancelError" | "error" | "status">> & {
  completed?: boolean;
};
export type CancellationHandler = (operation: OperationRecord) => void | Promise<void>;

interface InternalOperation extends OperationRecord {
  readonly controller: AbortController;
  readonly handlers: Set<CancellationHandler>;
}

export interface OperationRegistryOptions {
  readonly ttlMs?: number;
  readonly idPrefix?: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export class OperationRegistry {
  private readonly operations = new Map<string, InternalOperation>();
  private readonly ttlMs: number;
  private readonly idPrefix: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: OperationRegistryOptions = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? 60 * 60 * 1000);
    this.idPrefix = options.idPrefix ?? "chatgptop_";
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  create(kind: string, operationId?: string): OperationRecord {
    this.prune();
    const id = operationId || `${this.idPrefix}${this.idFactory().replaceAll("-", "")}`;
    const controller = new AbortController();
    const operation: InternalOperation = {
      id,
      operationId: id,
      kind,
      createdAt: this.now(),
      cancelRequested: false,
      completed: false,
      status: "pending",
      signal: controller.signal,
      controller,
      handlers: new Set(),
    };
    this.operations.set(id, operation);
    return operation;
  }

  get(operationId: string): OperationRecord | undefined {
    this.prune();
    return this.operations.get(operationId);
  }

  has(operationId: string): boolean { return this.get(operationId) !== undefined; }

  update(operationId: string | undefined, updates: OperationUpdate): OperationRecord | undefined {
    if (!operationId) return undefined;
    const operation = this.operations.get(operationId);
    if (!operation) return undefined;
    Object.assign(operation, updates);
    if (updates.completed === true) operation.completed = true;
    if (operation.completed && operation.status !== "cancelled" && operation.status !== "failed") operation.status = "completed";
    return operation;
  }

  start(operationId: string): OperationRecord | undefined { return this.update(operationId, { status: "running" }); }
  complete(operationId: string): OperationRecord | undefined { return this.update(operationId, { completed: true, status: "completed" }); }
  fail(operationId: string, error?: unknown): OperationRecord | undefined {
    return this.update(operationId, { status: "failed", error: error instanceof Error ? error.message : error ? String(error) : undefined, completed: true });
  }

  registerCancellation(operationId: string, handler: CancellationHandler): () => void {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`operation not found: ${operationId}`);
    operation.handlers.add(handler);
    return () => operation.handlers.delete(handler);
  }

  registerCancelHandler(operationId: string, handler: CancellationHandler): () => void {
    return this.registerCancellation(operationId, handler);
  }

  cancel(operationId: string): OperationRecord | undefined {
    const operation = this.operations.get(operationId);
    if (!operation) return undefined;
    if (!operation.cancelRequested) {
      operation.cancelRequested = true;
      operation.status = "cancelled";
      operation.controller.abort(new Error("operation cancelled"));
      for (const handler of operation.handlers) {
        try {
          const result = handler(operation);
          if (result && typeof (result as Promise<void>).catch === "function") void (result as Promise<void>).catch((error) => this.setCancelError(operation, error));
        } catch (error) {
          this.setCancelError(operation, error);
        }
      }
    }
    return operation;
  }

  async cancelAsync(operationId: string): Promise<OperationRecord | undefined> {
    const operation = this.operations.get(operationId);
    if (!operation) return undefined;
    if (!operation.cancelRequested) {
      operation.cancelRequested = true;
      operation.status = "cancelled";
      operation.controller.abort(new Error("operation cancelled"));
      const results = [...operation.handlers].map((handler) => Promise.resolve().then(() => handler(operation)));
      const settled = await Promise.allSettled(results);
      for (const result of settled) if (result.status === "rejected") this.setCancelError(operation, result.reason);
    }
    return operation;
  }

  isCancelRequested(operationId: string | undefined): boolean {
    return operationId ? Boolean(this.operations.get(operationId)?.cancelRequested) : false;
  }

  payload(operationId: string): Record<string, unknown> | undefined {
    const operation = this.get(operationId);
    return operation ? operationPayload(operation) : undefined;
  }

  list(): readonly OperationRecord[] { this.prune(); return [...this.operations.values()]; }

  prune(at = this.now()): number {
    const cutoff = at - this.ttlMs;
    let removed = 0;
    for (const [id, operation] of this.operations) {
      if (operation.completed && operation.createdAt < cutoff) {
        this.operations.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  private setCancelError(operation: InternalOperation, error: unknown): void {
    operation.lastCancelError = error instanceof Error ? error.message : String(error);
  }
}

export function operationPayload(operation: OperationRecord): Record<string, unknown> {
  const deepResearchReady = Boolean(operation.conversationId && operation.deepResearchMessageId && operation.deepResearchSessionId);
  let pendingReason: string | undefined;
  if (operation.kind === "research" && !operation.completed && !deepResearchReady) {
    pendingReason = !operation.provider ? "provider_not_selected" : !operation.conversationId ? "conversation_id_not_available" : "deep_research_session_not_available";
  }
  return {
    id: operation.id,
    kind: operation.kind,
    account: operation.account ?? null,
    provider_selected: Boolean(operation.provider),
    conversation_id: operation.conversationId ?? null,
    deep_research_message_id: operation.deepResearchMessageId ?? null,
    deep_research_session_id: operation.deepResearchSessionId ?? null,
    deep_research_ready: deepResearchReady,
    pending_reason: pendingReason ?? null,
    cancel_requested: operation.cancelRequested,
    completed: operation.completed,
    status: operation.status,
    last_cancel_result: operation.lastCancelResult ?? null,
    last_cancel_error: operation.lastCancelError ?? null,
    error: operation.error ?? null,
  };
}

export const OperationRegistryError = Error;

export const defaultOperationRegistry = new OperationRegistry();
export const createOperation = (kind: string, operationId?: string): OperationRecord => defaultOperationRegistry.create(kind, operationId);
export const getOperation = (operationId: string): OperationRecord | undefined => defaultOperationRegistry.get(operationId);
export const updateOperation = (operationId: string | undefined, updates: OperationUpdate): OperationRecord | undefined => defaultOperationRegistry.update(operationId, updates);
export const finishOperation = (operationId: string | undefined): OperationRecord | undefined => operationId ? defaultOperationRegistry.complete(operationId) : undefined;
export const cancelOperation = (operationId: string): OperationRecord | undefined => defaultOperationRegistry.cancel(operationId);
export const operationCancelRequested = (operationId: string | undefined): boolean => defaultOperationRegistry.isCancelRequested(operationId);
