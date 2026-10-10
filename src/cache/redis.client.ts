import Redis from 'ioredis';
import { Logger } from '@nestjs/common';

/**
 * Shared Redis connection.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 */
const logger = new Logger('RedisClient');

let client: Redis | null = null;

/** Upgrade redis:// → rediss:// in production so traffic is TLS-encrypted. */
function buildRedisUrl(raw: string): { url: string; tls: boolean } {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && raw.startsWith('redis://')) {
    return { url: raw.replace(/^redis:\/\//, 'rediss://'), tls: true };
  }
  return { url: raw, tls: raw.startsWith('rediss://') };
}

/** Register graceful-shutdown handlers once per process. */
let shutdownRegistered = false;
function registerShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received — closing Redis connection`);
    if (client) {
      try {
        await client.quit();
      } catch (err) {
        logger.error('Error while closing Redis connection', err);
      }
    }
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export function getRedis(): Redis {
  if (!client) {
    const rawUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const { url, tls } = buildRedisUrl(rawUrl);

    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      ...(tls ? { tls: {} } : {}),
    });

    // Finding 2: attach an error listener so connection errors are never
    // unhandled EventEmitter errors that would crash the process.
    client.on('error', (err: Error) => {
      logger.error('Redis client error', err);
    });

    // Finding 3: ensure the connection is cleanly closed on process shutdown.
    registerShutdown();
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
 * Release the triage lock only if this process still owns it.
 *
 * The Lua script is executed atomically by Redis, preventing the race where a
 * lock that expired and was re-acquired by another worker is deleted by the
 * first worker's finally block (finding 1).
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
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

export async function delCachedTriage(claimId: string): Promise<void> {
  await getRedis().del(`claims:triage:result:${claimId}`);
}
