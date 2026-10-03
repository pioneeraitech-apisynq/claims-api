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

    // Warn loudly when TLS is not configured so misconfiguration is visible at
    // startup rather than silently in production traffic.
    if (!url.startsWith('rediss://')) {
      console.warn(
        '[redis] REDIS_URL does not use the rediss:// scheme — ' +
          'traffic is unencrypted. Set REDIS_URL=rediss://... in production.',
      );
    }

    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      // Enable TLS when the rediss:// scheme is used.
      tls: url.startsWith('rediss://') ? {} : undefined,
    });

    // Attach an error handler so ioredis reconnect failures do not emit an
    // unhandled 'error' event and crash the Node.js process (finding #2).
    client.on('error', (err: Error) => {
      console.error('[redis] client error:', err.message);
    });
  }
  return client;
}

// Eagerly initialise the singleton at module load time so a misconfigured
// REDIS_URL causes a visible startup failure rather than a silent runtime
// surprise on the first request (finding #6).
getRedis();

const LOCK_TTL_SECONDS = 60;

// Atomic Lua script: delete the key only when its value matches the expected
// token, so the lock owner never deletes a lock it no longer holds (finding #1).
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Acquire a lock for a claim.
 *
 * Returns a unique ownership token when the lock is acquired, or `null` when
 * another worker already holds it. Pass the returned token to
 * `releaseTriageLock` so only the owner can release its own lock (finding #7).
 */
export async function acquireTriageLock(
  claimId: string,
): Promise<string | null> {
  // A cryptographically random token is unique across hosts, unlike process.pid
  // which can collide in containerised deployments (finding #7).
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
 * Release a triage lock.
 *
 * The supplied `token` is compared to the stored value inside an atomic Lua
 * script so the operation is a no-op when the TTL has already expired and
 * another worker has re-acquired the lock (finding #1).
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

export async function readCachedTriage<T>(claimId: string): Promise<T | null> {
  const raw = await getRedis().get(`claims:triage:result:${claimId}`);
  return raw ? (JSON.parse(raw) as T) : null;
}

/**
 * Cache non-PII triage result fields only.
 *
 * `rationale` and `fraudIndicators` may contain verbatim fragments of the
 * claim narrative (claimant name, medical details, incident description).
 * Stripping them before caching enforces data-minimisation: only objective,
 * non-narrative fields are persisted in Redis (finding #5).
 */
export async function writeCachedTriage(
  claimId: string,
  value: Record<string, unknown>,
  ttlSeconds = 900,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { rationale: _r, fraudIndicators: _f, ...safe } = value;
  await getRedis().set(
    `claims:triage:result:${claimId}`,
    JSON.stringify(safe),
    'EX',
    ttlSeconds,
  );
}

export async function deleteCachedTriage(claimId: string): Promise<void> {
  await getRedis().del(`claims:triage:result:${claimId}`);
}
