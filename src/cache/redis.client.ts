import Redis from 'ioredis';

/**
 * Shared Redis connection.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 */

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Warn loudly when the connection is not TLS-encrypted (finding 4).
// Switch the URL to rediss:// (or set REDIS_TLS=true) in production.
if (!redisUrl.startsWith('rediss://')) {
  // eslint-disable-next-line no-console
  console.warn(
    '[redis] Connection is NOT using TLS. Set REDIS_URL to a rediss:// URL in production.',
  );
}

const tlsOptions = redisUrl.startsWith('rediss://') ? { tls: {} } : {};

// Eagerly initialise the singleton so module load errors are surfaced at
// startup rather than on the first request (finding 6).
const client: Redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 2,
  lazyConnect: false,
  ...tlsOptions,
});

// Log connection errors instead of letting them crash the process (finding 2).
client.on('error', (err: Error) => {
  // eslint-disable-next-line no-console
  console.error('[redis] Connection error', err);
});

// Drain the connection cleanly on shutdown so the process does not hang in the
// ioredis reconnect loop (finding 6).
function shutdown() {
  client.quit().catch(() => client.disconnect());
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export function getRedis(): Redis {
  return client;
}

const LOCK_TTL_SECONDS = 60;

// Lua script for atomic compare-and-delete (finding 1).
// Deletes the key only when its value matches the caller's token.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Acquire a lock for a claim. Returns false when another worker holds it.
 * Returns false (non-fatal) on any Redis error (finding 7).
 */
export async function acquireTriageLock(claimId: string): Promise<boolean> {
  try {
    const result = await client.set(
      `claims:triage:lock:${claimId}`,
      process.pid.toString(),
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[redis] acquireTriageLock failed, skipping lock', err);
    // Treat as "not acquired" so the caller can still proceed without locking.
    return false;
  }
}

/**
 * Release a lock atomically. Only deletes the key when the stored value still
 * matches this process's PID, preventing a timed-out worker from evicting a
 * lock it no longer owns (finding 1).
 * Errors are swallowed — a leaked lock will expire via TTL (finding 7).
 */
export async function releaseTriageLock(claimId: string): Promise<void> {
  try {
    await client.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      `claims:triage:lock:${claimId}`,
      process.pid.toString(),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[redis] releaseTriageLock failed, lock will expire via TTL', err);
  }
}

/**
 * Read a cached triage result. Returns null on cache miss or Redis error
 * so the caller falls through to a fresh model run (finding 7).
 */
export async function readCachedTriage<T>(claimId: string): Promise<T | null> {
  try {
    const raw = await client.get(`claims:triage:result:${claimId}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[redis] readCachedTriage failed, bypassing cache', err);
    return null;
  }
}

/**
 * Write a triage result to the cache. Errors are swallowed — a missing cache
 * entry is non-fatal; the next call will simply re-run the model (finding 7).
 */
export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  try {
    await client.set(
      `claims:triage:result:${claimId}`,
      JSON.stringify(value),
      'EX',
      ttlSeconds,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[redis] writeCachedTriage failed, result not cached', err);
  }
}
