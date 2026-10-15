export interface SemaphoreLease {
  readonly release: () => void;
  readonly released: boolean;
}

interface Waiter {
  resolve: (lease: SemaphoreLease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("semaphore capacity must be a positive integer");
    this.available = capacity;
  }

  get pending(): number { return this.waiters.length; }
  get active(): number { return this.capacity - this.available; }

  acquire(signal?: AbortSignal): Promise<SemaphoreLease> {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise<SemaphoreLease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  async run<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(signal);
    try { return await operation(); } finally { lease.release(); }
  }

  private drain(): void {
    while (this.available > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        waiter.reject(abortError(waiter.signal.reason));
        continue;
      }
      this.available -= 1;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      let released = false;
      waiter.resolve({
        get released() { return released; },
        release: () => {
          if (released) return;
          released = true;
          this.available += 1;
          this.drain();
        },
      });
    }
  }
}

export interface AccountConcurrencyOptions {
  readonly defaultLimit?: number;
  readonly limits?: Readonly<Record<string, number>>;
  readonly planLimits?: Readonly<Record<string, number>>;
  readonly maxLimit?: number;
}

export interface AccountLease extends SemaphoreLease {
  readonly account: string;
}

export const DEFAULT_ACCOUNT_CONCURRENCY_BY_PLAN = Object.freeze({ free: 1, go: 2, plus: 3, pro: 4 });

/** Independent local throttles. A busy account never blocks another account. */
export class PerAccountConcurrency {
  private readonly semaphores = new Map<string, AsyncSemaphore>();
  private readonly configuredLimits = new Map<string, number>();
  private readonly defaultLimit: number;
  private readonly planLimits: Readonly<Record<string, number>>;
  private readonly maxLimit: number;

  constructor(options: AccountConcurrencyOptions = {}) {
    this.defaultLimit = normalizeLimit(options.defaultLimit ?? 1, 1);
    this.maxLimit = normalizeLimit(options.maxLimit ?? 32, 32);
    this.planLimits = options.planLimits ?? DEFAULT_ACCOUNT_CONCURRENCY_BY_PLAN;
    for (const [account, limit] of Object.entries(options.limits ?? {})) this.setLimit(account, limit);
  }

  setLimit(account: string, limit: number): void {
    const normalized = this.normalize(limit);
    this.configuredLimits.set(account, normalized);
    this.semaphores.set(account, new AsyncSemaphore(normalized));
  }

  limit(account: string): number {
    return this.configuredLimits.get(account) ?? this.planLimit(account);
  }

  semaphore(account: string): AsyncSemaphore {
    let semaphore = this.semaphores.get(account);
    if (!semaphore) {
      semaphore = new AsyncSemaphore(this.limit(account));
      this.semaphores.set(account, semaphore);
    }
    return semaphore;
  }

  async acquire(account: string, signal?: AbortSignal): Promise<AccountLease> {
    const lease = await this.semaphore(account).acquire(signal);
    return { account, get released() { return lease.released; }, release: lease.release };
  }

  async run<T>(account: string, operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(account, signal);
    try { return await operation(); } finally { lease.release(); }
  }

  private planLimit(account: string): number {
    const lowered = account.toLowerCase();
    for (const plan of ["pro", "plus", "go", "free"]) {
      if (lowered.includes(plan)) return this.normalize(this.planLimits[plan] ?? this.defaultLimit);
    }
    return this.defaultLimit;
  }

  private normalize(value: number): number {
    return normalizeLimit(value, this.defaultLimit, this.maxLimit);
  }
}

export const AccountConcurrency = PerAccountConcurrency;

function normalizeLimit(value: number, fallback: number, max = 32): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  error.name = "AbortError";
  return error;
}
