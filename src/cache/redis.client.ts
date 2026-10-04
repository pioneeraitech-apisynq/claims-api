import Redis from 'ioredis';

/**
 * Shared Redis connection.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 *
 * IMPORTANT: REDIS_URL must use the `rediss://` scheme (TLS) in production so
 * that sensitive triage/medical data is encrypted in transit.  The plaintext
 * `redis://` scheme is only acceptable for local development.
 */
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    // Default to TLS-enabled loopback for safety; override via REDIS_URL.
    client = new Redis(process.env.REDIS_URL || 'rediss://127.0.0.1:6380', {
      // Raise retry count so brief failovers / blips don't immediately surface
      // as errors in cache reads and lock operations (finding 5).
      maxRetriesPerRequest: 10,
      lazyConnect: false,
    });
  }
  return client;
}

/**
 * Drain and close the shared Redis connection.  Call this from process
 * shutdown hooks so in-flight commands complete and the server-side connection
 * slot is released cleanly (finding 3).
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

// 5 minutes — generous enough to outlast a slow LLM + Pinecone + policy-API
// round-trip so the lock never expires while triage is still running (finding 4).
const LOCK_TTL_SECONDS = 300;

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

export async function invalidateCachedTriage(claimId: string): Promise<void> {
  await getRedis().del(`claims:triage:result:${claimId}`);
}
