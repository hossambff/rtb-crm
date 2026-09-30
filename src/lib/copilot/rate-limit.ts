/**
 * Simple in-memory token bucket per user (per server instance). A DB-backed hourly cap on agent_runs complements it
 * across instances (see route handler). Pure apart from the module-level Map; clock is injectable for tests.
 */
export type Bucket = { tokens: number; updatedAt: number };

export class TokenBucket {
  private buckets = new Map<string, Bucket>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Try to take one token. Returns { ok, retryAfterSec }. */
  take(key: string): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: t };
    const elapsed = Math.max(0, (t - b.updatedAt) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.updatedAt = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { ok: true, retryAfterSec: 0 };
    }
    this.buckets.set(key, b);
    return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / this.refillPerSec) };
  }
}

const g = globalThis as unknown as { __copilotBucket?: TokenBucket };
/** 8 messages burst, refilling one every 5s. */
export const copilotBucket: TokenBucket = g.__copilotBucket ?? (g.__copilotBucket = new TokenBucket(8, 0.2));
