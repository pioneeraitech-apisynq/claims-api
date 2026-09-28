import Redis from 'ioredis';

/**
 * Shared Redis connection.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 */
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      // null → unlimited per-request retries, governed solely by retryStrategy
      // (finding 1: the previous value of 2 caused premature failures on transient
      // network blips and left distributed locks held for the full TTL)
      maxRetriesPerRequest: null,

      // Exponential back-off capped at 5 s; ioredis stops retrying after
      // ~30 s total by returning null from the strategy (finding 1).
      retryStrategy(times: number): number | null {
        if (times > 10) {
          // Give up after ~10 attempts (~30 s total); let the command fail.
          return null;
        }
        return Math.min(100 * 2 ** times, 5_000);
      },

      // lazyConnect: true → no TCP connection is opened until connectRedis()
      // is called inside the NestJS OnModuleInit hook.  This means a failed
      // Redis host surfaces as a clean bootstrap error rather than an
      // unhandled promise rejection at module-import time (finding 4).
      lazyConnect: true,
    });
  }
  return client;
}

/**
 * Open the Redis connection.  Call this inside a NestJS OnModuleInit hook so
 * that the connection is established during app bootstrap and any error is
 * caught before the server starts accepting traffic (finding 4).
 */
export async function connectRedis(): Promise<void> {
  await getRedis().connect();
}

/**
 * Gracefully close the Redis connection.  Call this inside a NestJS
 * OnApplicationShutdown hook so in-flight commands are drained before the
 * process exits (finding 2).
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

const LOCK_TTL_SECONDS = 60;

/**
 * Acquire a lock for a claim. Returns false when another worker holds it.
 */
export async function acquireTriageLock(claimId: string): Promise<boolean> {
  const result = await getRedis().set(
    `claims:triage:lock:${claimId}`,
    process.pid.toString(),
    'EX',
    LOCK_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

export async function releaseTriageLock(claimId: string): Promise<void> {
  await getRedis().del(`claims:triage:lock:${claimId}`);
}

export async function readCachedTriage<T>(claimId: string): Promise<T | null> {
  const raw = await getRedis().get(`claims:triage:result:${claimId}`);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  await getRedis().set(
    `claims:triage:result:${claimId}`,
    JSON.stringify(value),
    'EX',
    ttlSeconds,
  );
}
