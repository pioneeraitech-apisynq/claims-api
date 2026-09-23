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
