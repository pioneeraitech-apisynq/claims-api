import Redis from 'ioredis';
import { randomUUID } from 'crypto';

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
    client = new Redis(
      process.env.REDIS_URL || 'rediss://127.0.0.1:6379',
      {
        // null = retry until reconnected (ioredis default). The previous value
        // of 2 caused commands to fail immediately on a brief network hiccup.
        maxRetriesPerRequest: null,
        lazyConnect: false,
      },
    );

    // Without this listener, ioredis connection errors become uncaught
    // exceptions that crash the Node.js process.
    client.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error('[redis] client error:', err);
    });
  }
  return client;
}

/**
 * Gracefully close the shared Redis connection.
 * Call this from the NestJS shutdown hook (onModuleDestroy / app.close()).
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

const LOCK_TTL_SECONDS = 60;

/**
 * Acquire a lock for a claim. Returns the unique owner token that must be
 * supplied to releaseTriageLock(), or null when another worker holds the lock.
 *
 * The token is a random UUID so ownership is globally unique even when the
 * service is scaled across many hosts (process.pid is only unique per host).
 */
export async function acquireTriageLock(
  claimId: string,
): Promise<string | null> {
  const token = randomUUID();
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
 * Release the lock atomically using a Lua script that verifies ownership before
 * deleting. If the TTL has expired and a second worker has re-acquired the lock
 * under the same key, this is a no-op rather than deleting the new owner's lock.
 */
export async function releaseTriageLock(
  claimId: string,
  token: string,
): Promise<void> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await getRedis().eval(script, 1, `claims:triage:lock:${claimId}`, token);
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
