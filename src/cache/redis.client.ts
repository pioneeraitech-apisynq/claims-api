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

    // Finding #3 — ioredis emits 'error' on the EventEmitter; without a
    // listener this would crash the process with an uncaught exception.
    client.on('error', (err) => console.error('Redis client error', err));
  }
  return client;
}

/**
 * Close the shared connection. Call this from a NestJS OnModuleDestroy hook or
 * test teardown so the process does not hang on exit (finding #6).
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

// Finding #2 — 60 s was shorter than the combined latency of two Policy API
// calls plus a full model invocation under load. 600 s (10 minutes) gives
// ample headroom while still guaranteeing the lock is eventually released even
// if the worker crashes before the finally block runs.
const LOCK_TTL_SECONDS = 600;

// Lua script for atomic compare-and-delete (finding #1).
// Deletes the key only when the stored value matches the caller's token;
// returns 1 on success, 0 when the lock is owned by someone else or has
// already expired.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

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

/**
 * Release the lock only if this process still owns it (finding #1).
 *
 * The Lua script executes atomically on the Redis server: if the lock has
 * already expired and been re-acquired by another worker, the DEL is skipped,
 * preventing lock theft.
 */
export async function releaseTriageLock(claimId: string): Promise<void> {
  await getRedis().eval(
    RELEASE_LOCK_SCRIPT,
    1,
    `claims:triage:lock:${claimId}`,
    process.pid.toString(),
  );
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
