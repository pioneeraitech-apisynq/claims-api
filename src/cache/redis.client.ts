import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Lifecycle-managed Redis provider.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 *
 * The connection is opened once in `onModuleInit` and closed gracefully in
 * `onModuleDestroy`, ensuring in-flight commands are flushed before the
 * process exits (requires `app.enableShutdownHooks()` in main.ts).
 *
 * `maxRetriesPerRequest` is left at the ioredis default of `null` (unlimited
 * retries with exponential back-off) so transient network hiccups do not
 * immediately surface as command errors.
 */
@Injectable()
export class RedisClient implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  onModuleInit() {
    this.client = new Redis(
      process.env.REDIS_URL || 'redis://127.0.0.1:6379',
      {
        maxRetriesPerRequest: null,
        lazyConnect: false,
      },
    );
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  // ── low-level access ────────────────────────────────────────────────────────

  getConnection(): Redis {
    return this.client;
  }

  // ── distributed lock ────────────────────────────────────────────────────────

  private readonly LOCK_TTL_SECONDS = 60;

  /**
   * Acquire a lock for a claim. Returns false when another worker holds it.
   */
  async acquireTriageLock(claimId: string): Promise<boolean> {
    const result = await this.client.set(
      `claims:triage:lock:${claimId}`,
      process.pid.toString(),
      'EX',
      this.LOCK_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }

  async releaseTriageLock(claimId: string): Promise<void> {
    await this.client.del(`claims:triage:lock:${claimId}`);
  }

  // ── triage result cache ─────────────────────────────────────────────────────

  async readCachedTriage<T>(claimId: string): Promise<T | null> {
    const raw = await this.client.get(`claims:triage:result:${claimId}`);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async writeCachedTriage(
    claimId: string,
    value: unknown,
    ttlSeconds = 900,
  ): Promise<void> {
    await this.client.set(
      `claims:triage:result:${claimId}`,
      JSON.stringify(value),
      'EX',
      ttlSeconds,
    );
  }
}
