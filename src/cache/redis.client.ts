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
 * Upgrade a plain redis:// URL to rediss:// when it resolves to a non-loopback
 * host, so traffic to remote Redis instances is always TLS-encrypted.
 */
function buildRedisUrl(raw: string): { url: string; tls: boolean } {
  let url = raw;
  let tls = false;

  if (url.startsWith('redis://')) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      const isLocal =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1';
      if (!isLocal) {
        url = 'rediss://' + url.slice('redis://'.length);
        tls = true;
      }
    } catch {
      // If the URL cannot be parsed, leave it unchanged and let ioredis surface
      // the error at connection time.
    }
  } else if (url.startsWith('rediss://')) {
    tls = true;
  }

  return { url, tls };
}

export function getRedis(): Redis {
  if (!client) {
    const rawUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const { url, tls } = buildRedisUrl(rawUrl);

    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      commandTimeout: 2000,
      ...(tls ? { tls: {} } : {}),
    });

    // Finding 3: attach an error listener so unhandled 'error' events on the
    // EventEmitter do not terminate the process.
    client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[redis] connection error', err);
    });

    // Finding 4: gracefully close the connection on process shutdown so
    // in-flight commands complete and the handle does not delay process exit.
    const shutdown = () => {
      if (client) {
        client.quit().catch(() => client?.disconnect());
      }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
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

/**
 * Lua script for an atomic owner-checked lock release.
 *
 * Reads the current lock value; only deletes the key when it still belongs to
 * this process. Returns 1 if deleted, 0 if not owned (already expired or taken
 * by another worker). This prevents the original lock holder from accidentally
 * evicting a lock acquired by a different worker after TTL expiry.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export async function releaseTriageLock(claimId: string): Promise<void> {
  await (getRedis() as Redis).eval(
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
  // NX: only write when no cached value exists yet. This prevents a racing
  // forced-triage from overwriting a fresher result written by the lock holder.
  await getRedis().set(
    `claims:triage:result:${claimId}`,
    JSON.stringify(value),
    'EX',
    ttlSeconds,
    'NX',
  );
}
