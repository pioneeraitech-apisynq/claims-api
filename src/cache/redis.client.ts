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
      // Raise from 2 → 5 so brief network blips / replica failovers do not
      // immediately surface as user-visible 500s (finding: maxRetriesPerRequest
      // too low).
      maxRetriesPerRequest: 5,
      lazyConnect: false,
    });

    // Without an 'error' listener, ioredis unhandled error events crash the
    // Node.js process. Log and let ioredis retry internally (finding: no error
    // event handler).
    client.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error('[redis] connection error', err);
    });
  }
  return client;
}

/**
 * Gracefully close the Redis connection. Call this from your application
 * shutdown hook so the process does not hang on pod termination (finding:
 * no graceful shutdown).
 *
 * Example (main.ts):
 *   app.enableShutdownHooks();
 *   process.on('beforeExit', () => closeRedis());
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

// 300 s gives headroom beyond the realistic triage wall-clock time (MongoDB
// lookup + two Policy-API calls + LLM/Pinecone round-trips). The previous
// 60 s could expire while the first worker was still mid-flight, allowing a
// second worker to acquire the lock and run a parallel triage (finding: TTL
// too short).
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

/**
 * Lua script for atomic check-and-delete: only deletes the lock key when the
 * stored value matches this worker's PID, preventing a worker whose lock
 * already expired from deleting a live lock held by a different worker
 * (finding: non-atomic distributed lock release).
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

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

/**
 * Bust the triage cache for a claim. Must be called whenever the claim is
 * materially mutated (e.g. a document is added) so that a subsequent triage
 * call does not return a stale pre-mutation result (finding: cache not
 * invalidated on claim mutation).
 */
export async function invalidateCachedTriage(claimId: string): Promise<void> {
  await getRedis().del(`claims:triage:result:${claimId}`);
}
