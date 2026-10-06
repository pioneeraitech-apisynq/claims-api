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
    client = new Redis(process.env.REDIS_URL || 'rediss://127.0.0.1:6379', {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });

    // Finding #2 / #4 — attach an error listener immediately so transient
    // connection drops are logged and retried by ioredis rather than emitting
    // an unhandled 'error' event that would crash the process.
    client.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error('[redis] client error', err);
    });
  }
  return client;
}

/**
 * Finding #6 — gracefully close the Redis connection.
 * Call this during process shutdown (SIGTERM / SIGINT / onModuleDestroy).
 */
export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

const LOCK_TTL_SECONDS = 60;

// Lua script for atomic compare-and-delete (finding #1).
// Returns 1 if the key was deleted (caller owned the lock), 0 otherwise.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Acquire a lock for a claim. Returns false when another worker holds it.
 * The value stored is the process PID, used as the caller's identity token
 * when releasing or extending the lock.
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
 * Finding #1 — atomically release the lock only if we still own it.
 * Uses a Lua script so the read-compare-delete is a single atomic operation,
 * preventing a late-finishing worker from deleting a lock acquired by another.
 */
export async function releaseTriageLock(claimId: string): Promise<void> {
  await getRedis().eval(
    RELEASE_LOCK_SCRIPT,
    1,
    `claims:triage:lock:${claimId}`,
    process.pid.toString(),
  );
}

/**
 * Finding #5 — extend the lock TTL while a long-running triage is still in
 * flight.  Call this periodically (e.g. every 30 s) from the triage worker.
 * Uses SET … EX … XX so the extension is a no-op if the lock has already
 * expired (i.e. we no longer own it and should not extend).
 */
export async function refreshTriageLock(claimId: string): Promise<boolean> {
  const current = await getRedis().get(`claims:triage:lock:${claimId}`);
  if (current !== process.pid.toString()) {
    return false;
  }
  const result = await getRedis().set(
    `claims:triage:lock:${claimId}`,
    process.pid.toString(),
    'EX',
    LOCK_TTL_SECONDS,
    'XX',
  );
  return result === 'OK';
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
