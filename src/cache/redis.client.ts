import { Module, OnModuleDestroy, Inject } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Factory provider – creates the shared ioredis connection.
 * The client is exposed under the `REDIS_CLIENT` injection token so that
 * NestJS owns the object lifecycle: `OnModuleDestroy` closes the connection
 * cleanly on application shutdown and tests can swap the provider without
 * monkey-patching the module.
 */
const redisClientProvider = {
  provide: REDIS_CLIENT,
  useFactory: (): Redis => {
    return new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
  },
};

@Module({
  providers: [redisClientProvider, RedisLifecycle],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}

/**
 * Thin service whose only job is to hold a reference to the client so that
 * `OnModuleDestroy` can quit it gracefully when the application shuts down.
 */
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit();
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions – each accepts an explicit Redis instance so they work
// inside the DI world (ClaimsService injects the client and passes it in) and
// also remain unit-testable without any module-level state.
// ---------------------------------------------------------------------------

const LOCK_TTL_SECONDS = 60;

/**
 * Acquire a lock for a claim. Returns false when another worker holds it.
 */
export async function acquireTriageLock(
  redis: Redis,
  claimId: string,
): Promise<boolean> {
  const result = await redis.set(
    `claims:triage:lock:${claimId}`,
    process.pid.toString(),
    'EX',
    LOCK_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

export async function releaseTriageLock(
  redis: Redis,
  claimId: string,
): Promise<void> {
  await redis.del(`claims:triage:lock:${claimId}`);
}

export async function readCachedTriage<T>(
  redis: Redis,
  claimId: string,
): Promise<T | null> {
  const raw = await redis.get(`claims:triage:result:${claimId}`);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function writeCachedTriage(
  redis: Redis,
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  await redis.set(
    `claims:triage:result:${claimId}`,
    JSON.stringify(value),
    'EX',
    ttlSeconds,
  );
}
