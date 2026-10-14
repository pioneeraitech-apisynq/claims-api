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
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
  }
  return client;
}

/**
 * Gracefully drain pending commands and close the connection.
 * Call this inside an onApplicationShutdown / SIGTERM handler.
 */
export async function disconnectRedis(): Promise<void> {
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

/**
 * Write a triage result to the cache and atomically return the value that was
 * stored there previously (or null on a cold miss).
 *
 * Uses the Redis ≥ 6.2 `SET key value GET EX ttl` form so the caller gets the
 * old value in a single round-trip — no separate GET needed.
 */
export async function writeCachedTriage<T>(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<T | null> {
  // ioredis types `SET … GET` as returning `string | null`.
  const previous = await (getRedis() as Redis).call(
    'SET',
    `claims:triage:result:${claimId}`,
    JSON.stringify(value),
    'GET',
    'EX',
    String(ttlSeconds),
  ) as string | null;
  return previous ? (JSON.parse(previous) as T) : null;
}

/**
 * Read a cached triage result without disturbing the stored value.
 * Returns null on a cache miss.
 */
export async function readCachedTriage<T>(claimId: string): Promise<T | null> {
  const raw = await getRedis().get(`claims:triage:result:${claimId}`);
  return raw ? (JSON.parse(raw) as T) : null;
}
