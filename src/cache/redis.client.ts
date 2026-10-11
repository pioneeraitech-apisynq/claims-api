import Redis from 'ioredis';
import { randomBytes } from 'crypto';

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
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const useTls = url.startsWith('rediss://');

    client = new Redis(url, {
      maxRetriesPerRequest: 5,
      lazyConnect: false,
      ...(useTls ? { tls: {} } : {}),
    });

    // Prevent uncaught 'error' events from crashing the process (finding 4).
    client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[Redis] connection error', err);
    });
  }
  return client;
}

const LOCK_TTL_SECONDS = 60;

/**
 * Lua script for atomic compare-and-delete: only deletes the key when the
 * stored value matches the supplied token, preventing a worker from releasing
 * another worker's lock (finding 1).
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Acquire a lock for a claim. Returns a unique nonce token when the lock was
 * acquired, or null when another worker already holds it.
 *
 * The token is a random 16-byte hex string rather than process.pid, which is
 * not unique across containers (finding 3).
 */
export async function acquireTriageLock(
  claimId: string,
): Promise<string | null> {
  const token = randomBytes(16).toString('hex');
  const result = await getRedis().set(
    `claims:triage:lock:${claimId}`,
    token,
    'EX',
    LOCK_TTL_SECONDS,
    'NX',
  );
  return result === 'OK' ? token : null;
}

/**
 * Release a lock. The Lua script atomically verifies ownership before
 * deleting, so an expired lock that has been re-acquired by another worker is
 * never accidentally deleted (finding 1).
 */
export async function releaseTriageLock(
  claimId: string,
  token: string,
): Promise<void> {
  await getRedis().eval(
    RELEASE_LOCK_SCRIPT,
    1,
    `claims:triage:lock:${claimId}`,
    token,
  );
}

/**
 * Unconditionally delete the cached triage entry for a claim. Used when a
 * forced re-triage is requested so stale data is never served if the new run
 * fails (finding 7).
 */
export async function deleteTriageLock(claimId: string): Promise<void> {
  await getRedis().del(`claims:triage:result:${claimId}`);
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
