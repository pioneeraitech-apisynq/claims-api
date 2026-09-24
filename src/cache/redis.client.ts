import Redis from 'ioredis';

/**
 * Shared Redis connection.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 */
let client: Redis | null = null;

/**
 * Lua script for atomic compare-and-delete.
 * Returns 1 when the key was deleted (caller owns the lock), 0 otherwise.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      // Reconnect with exponential back-off, capped at 10 s, giving up after
      // 20 consecutive failed attempts so we do not spin forever.
      retryStrategy(times: number): number | null {
        if (times > 20) {
          return null; // stop reconnecting
        }
        return Math.min(100 * 2 ** times, 10_000);
      },
    });

    // Finding 2: attach an error handler so a dropped TCP connection never
    // surfaces as an unhandled EventEmitter 'error' that kills the process.
    client.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error('[redis] client error', err);
    });
  }
  return client;
}

/**
 * Eagerly initialise the Redis client and wait for the first successful
 * connection. Call this once during application bootstrap so a bad REDIS_URL
 * or firewall block surfaces immediately as a startup failure rather than a
 * silent latent error on the first request.
 *
 * Finding 6: eager singleton initialisation.
 */
export async function initRedis(): Promise<void> {
  await getRedis().connect().catch(() => {
    // connect() rejects if the client is already connecting/connected; that is
    // expected when getRedis() was called before initRedis(), so ignore it.
  });
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

/**
 * Release the triage lock only when this process still owns it.
 *
 * Finding 1: the previous unconditional DEL could silently delete a lock that
 * had already expired and been re-acquired by another worker, allowing two
 * concurrent triage runs. The Lua script makes the GET + DEL atomic.
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

/**
 * Write a triage result to the cache.
 *
 * Finding 4: any `medicalNotes` field present on the value is stripped before
 * serialisation so raw health information is never persisted to Redis even if
 * the call site accidentally passes a wider object that contains it.
 */
export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  const sanitised =
    value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([k]) => k !== 'medicalNotes',
          ),
        )
      : value;

  await getRedis().set(
    `claims:triage:result:${claimId}`,
    JSON.stringify(sanitised),
    'EX',
    ttlSeconds,
  );
}
