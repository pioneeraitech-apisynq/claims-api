import Redis from 'ioredis';
import { Global, Inject, Module, OnModuleDestroy, Provider } from '@nestjs/common';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Rewrite redis:// → rediss:// so that traffic between this service and the
 * Redis server is always TLS-encrypted. PII (cached triage results, medical
 * notes) must never travel in plaintext.
 */
function toTlsUrl(url: string): string {
  if (url.startsWith('redis://')) {
    return 'rediss://' + url.slice('redis://'.length);
  }
  return url;
}

function createRedisClient(): Redis {
  const rawUrl = process.env.REDIS_URL || 'rediss://127.0.0.1:6379';
  const url = toTlsUrl(rawUrl);
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    tls: {},
  });
}

const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: createRedisClient,
};

@Global()
@Module({
  providers: [redisProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}

// ---------------------------------------------------------------------------
// Helpers used by ClaimsService and HealthController.
// Each function receives the injected client so it never touches the old
// module-level singleton.
// ---------------------------------------------------------------------------

const LOCK_TTL_SECONDS = 60;

/**
 * Acquire a lock for a claim. Returns false when another worker holds it.
 */
export async function acquireTriageLock(
  client: Redis,
  claimId: string,
): Promise<boolean> {
  const result = await client.set(
    `claims:triage:lock:${claimId}`,
    process.pid.toString(),
    'EX',
    LOCK_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

export async function releaseTriageLock(
  client: Redis,
  claimId: string,
): Promise<void> {
  await client.del(`claims:triage:lock:${claimId}`);
}

export async function readCachedTriage<T>(
  client: Redis,
  claimId: string,
): Promise<T | null> {
  const raw = await client.get(`claims:triage:result:${claimId}`);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function writeCachedTriage(
  client: Redis,
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  await client.set(
    `claims:triage:result:${claimId}`,
    JSON.stringify(value),
    'EX',
    ttlSeconds,
  );
}
