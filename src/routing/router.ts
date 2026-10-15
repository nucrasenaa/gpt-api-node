export const ACCOUNT_STRATEGIES = ["auto", "sticky", "failover", "random", "round-robin", "weighted", "quota-aware"] as const;
export type AccountStrategy = typeof ACCOUNT_STRATEGIES[number];
import { PerAccountConcurrency, type AccountLease } from "./semaphore.js";

export interface AccountQuota {
  readonly remaining?: number;
  readonly limit?: number;
  readonly resetAt?: number | string;
  readonly rateLimitedUntil?: number;
  readonly available?: boolean;
}

export interface AccountRouterOptions {
  readonly weights?: Readonly<Record<string, number>>;
  readonly quotas?: Readonly<Record<string, AccountQuota>>;
  readonly quotaProvider?: (account: string) => AccountQuota | undefined;
  readonly random?: () => number;
  readonly concurrency?: PerAccountConcurrency;
}

export function normalizeAccountStrategy(strategy?: string): AccountStrategy {
  const normalized = (strategy ?? "auto").trim().toLowerCase().replaceAll("_", "-");
  const aliases: Record<string, AccountStrategy> = {
    default: "auto",
    "limit-aware": "quota-aware",
    shuffle: "random",
    rotate: "round-robin",
    roundrobin: "round-robin",
  };
  const result = aliases[normalized] ?? normalized;
  if (!ACCOUNT_STRATEGIES.includes(result as AccountStrategy)) throw new Error(`unsupported account strategy: ${strategy}`);
  return result as AccountStrategy;
}

export function accountPlanHint(account: string): string | undefined {
  const lowered = account.toLowerCase();
  return ["pro", "plus", "go", "free"].find((plan) => lowered.includes(plan));
}

export function defaultAccountWeight(account: string): number {
  return { free: 1, go: 2, plus: 4, pro: 10 }[accountPlanHint(account) ?? "free"] ?? 1;
}

/** Produces a complete candidate order; callers can try candidates until one succeeds. */
export class AccountRouter {
  readonly accounts: readonly string[];
  readonly strategy: AccountStrategy;
  private readonly weights: Readonly<Record<string, number>>;
  private readonly quotas = new Map<string, AccountQuota>();
  private readonly quotaProvider?: (account: string) => AccountQuota | undefined;
  private readonly random: () => number;
  readonly concurrency: PerAccountConcurrency;
  private counter = 0;
  private stickyAccount?: string;
  private readonly failed = new Set<string>();

  constructor(accounts: readonly string[], strategy: string = "auto", options: AccountRouterOptions = {}) {
    const unique = [...new Set(accounts.map((account) => account.trim()).filter(Boolean))];
    if (unique.length === 0) throw new Error("at least one account is required");
    this.accounts = unique;
    this.strategy = normalizeAccountStrategy(strategy);
    this.weights = options.weights ?? {};
    this.quotaProvider = options.quotaProvider;
    this.random = options.random ?? Math.random;
    this.concurrency = options.concurrency ?? new PerAccountConcurrency();
    for (const [account, quota] of Object.entries(options.quotas ?? {})) this.quotas.set(account, quota);
  }

  order(): readonly string[] {
    const base = this.availableAccounts();
    if (base.length <= 1) return base;
    switch (this.strategy) {
      case "random": return this.shuffle(base);
      case "round-robin": return this.rotate(base, this.counter++ % base.length);
      case "weighted": return this.weightedOrder(base);
      case "quota-aware": return this.quotaAwareOrder(base);
      case "sticky":
      case "auto":
      case "failover":
      default: return this.stickyFirst(base);
    }
  }

  candidates(): readonly string[] { return this.order(); }

  setAccountLimit(account: string, limit: number): void { this.concurrency.setLimit(account, limit); }
  accountLimit(account: string): number { return this.concurrency.limit(account); }
  acquire(account: string, signal?: AbortSignal): Promise<AccountLease> { return this.concurrency.acquire(account, signal); }

  setQuota(account: string, quota: AccountQuota): void { this.quotas.set(account, quota); }
  setAccountQuota(account: string, quota: AccountQuota): void { this.setQuota(account, quota); }

  markFailure(account: string): void {
    if (!this.accounts.includes(account)) return;
    this.failed.add(account);
    if (this.stickyAccount === account) this.stickyAccount = undefined;
  }

  markSuccess(account: string): void {
    if (!this.accounts.includes(account)) return;
    this.failed.delete(account);
    if (this.strategy === "sticky" || this.strategy === "auto") this.stickyAccount = account;
  }

  resetFailures(): void { this.failed.clear(); }

  private availableAccounts(): string[] {
    const available = this.accounts.filter((account) => !this.failed.has(account) && (this.strategy !== "quota-aware" || this.isQuotaAvailable(account)));
    return available.length > 0 ? available : [...this.accounts];
  }

  private isQuotaAvailable(account: string): boolean {
    const quota = this.quota(account);
    if (!quota) return true;
    if (quota.available === false || quota.remaining !== undefined && quota.remaining <= 0) return false;
    return quota.rateLimitedUntil === undefined || quota.rateLimitedUntil <= Date.now();
  }

  private quota(account: string): AccountQuota | undefined {
    return this.quotaProvider?.(account) ?? this.quotas.get(account);
  }

  private stickyFirst(accounts: string[]): readonly string[] {
    const preferred = this.stickyAccount && accounts.includes(this.stickyAccount) ? this.stickyAccount : accounts[0];
    return preferred ? [preferred, ...accounts.filter((account) => account !== preferred)] : accounts;
  }

  private weightedOrder(accounts: string[]): readonly string[] {
    const expanded: string[] = [];
    for (const account of accounts) {
      const raw = this.weights[account] ?? defaultAccountWeight(account);
      const weight = Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : 1;
      expanded.push(...Array.from({ length: weight }, () => account));
    }
    const start = this.counter++ % expanded.length;
    return [...new Set([...expanded.slice(start), ...expanded.slice(0, start)])];
  }

  private quotaAwareOrder(accounts: string[]): readonly string[] {
    const position = new Map(this.accounts.map((account, index) => [account, index]));
    return [...accounts].sort((left, right) => {
      const l = this.quota(left);
      const r = this.quota(right);
      const lRemaining = l?.remaining ?? Number.POSITIVE_INFINITY;
      const rRemaining = r?.remaining ?? Number.POSITIVE_INFINITY;
      if (lRemaining !== rRemaining) return rRemaining - lRemaining;
      const lRatio = l?.limit && l.limit > 0 && l.remaining !== undefined ? l.remaining / l.limit : Number.POSITIVE_INFINITY;
      const rRatio = r?.limit && r.limit > 0 && r.remaining !== undefined ? r.remaining / r.limit : Number.POSITIVE_INFINITY;
      return lRatio === rRatio ? (position.get(left) ?? 0) - (position.get(right) ?? 0) : rRatio - lRatio;
    });
  }

  private rotate(accounts: string[], start: number): readonly string[] {
    return [...accounts.slice(start), ...accounts.slice(0, start)];
  }

  private shuffle(accounts: string[]): readonly string[] {
    const result = [...accounts];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(this.random() * (index + 1));
      [result[index], result[randomIndex]] = [result[randomIndex]!, result[index]!];
    }
    return result;
  }
}

export const Router = AccountRouter;
