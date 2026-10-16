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
      // Do NOT set maxRetriesPerRequest here — the ioredis default (null) queues
      // commands while reconnecting, which is the correct behaviour for transient
      // outages (leader elections, rolling restarts).  Fast-fail would surface
      // recoverable blips as 5xx errors to API consumers.
      lazyConnect: false,
    });
  }
  return client;
}

/**
 * Gracefully close the Redis connection, flushing any pending commands first.
 * Call this from the application's shutdown hook (SIGTERM / SIGINT).
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
  // Use SET … GET (Redis 6.2+) so the operation is atomic: we write the new
  // value and receive the previous value in one round-trip.  A non-null
  // previous value means a concurrent request already populated the cache;
  // we log it so races are observable without treating them as errors.
  const previous = await getRedis().set(
    `claims:triage:result:${claimId}`,
    JSON.stringify(value),
    'GET',
    'EX',
    ttlSeconds,
  );
  if (previous !== null) {
    // eslint-disable-next-line no-console
    console.warn(
      `[redis] writeCachedTriage: concurrent write detected for claim ${claimId} — previous value was overwritten`,
    );
  }
}
