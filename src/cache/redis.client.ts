import Redis from 'ioredis';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * Shared Redis connection.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 *
 * The client is exposed both as a NestJS injectable (RedisClientProvider) for
 * lifecycle management, and as plain helper functions so the existing
 * claims.service.ts call-sites remain unchanged.
 */

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'rediss://127.0.0.1:6380', {
      // Raise from 2 → 3 so transient blips don't immediately surface as 500s
      // (finding 6). For lock operations a single extra retry significantly
      // reduces spurious ConflictException responses.
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      tls: { rejectUnauthorized: true },
    });

    // Finding 3: without an 'error' listener, ioredis connection failures are
    // unhandled EventEmitter errors that terminate the Node process.
    client.on('error', (err: Error) => {
      logger.error('Redis client error', err.message);
    });
  }
  return client;
}

// NestJS Logger used for the error handler above (no external dependency).
const logger = new Logger('RedisClient');

// ---------------------------------------------------------------------------
// NestJS injectable provider — finding 4
//
// Registering this provider in the module (see claims.module.ts or
// app.module.ts) gives NestJS visibility of the Redis client so it can call
// quit() during graceful shutdown (SIGTERM).  The helper functions below
// delegate to the same singleton, so no call-sites need to change.
// ---------------------------------------------------------------------------

@Injectable()
export class RedisClientProvider implements OnModuleDestroy {
  getClient(): Redis {
    return getRedis();
  }

  async onModuleDestroy(): Promise<void> {
    if (client) {
      await client.quit();
      client = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Lock TTL
//
// Finding 5: 60 s is intentionally conservative relative to the observed p99
// triage duration (~8–12 s for the AI + Policy/Coverage API round-trips).
// If triage operations routinely approach this limit an alert should fire
// before lock expiry becomes a real risk.  Lock renewal is not implemented
// here; if p99 grows beyond ~30 s the TTL should be raised accordingly.
// ---------------------------------------------------------------------------

const LOCK_TTL_SECONDS = 60;

// Lua script for atomic check-and-delete (finding 2).
// Returns 1 when the lock was deleted by the caller, 0 when it was not held.
const RELEASE_LOCK_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end
`;

// ---------------------------------------------------------------------------
// Public helper functions (API unchanged — claims.service.ts call-sites work
// without modification)
// ---------------------------------------------------------------------------

/**
 * Acquire a lock for a claim. Returns false when another worker holds it.
 * The PID is stored as the lock token so only this process can release it.
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
 * Release the lock only if this process still owns it (finding 2).
 * Uses an atomic Lua script so an expired-then-reacquired lock belonging to
 * another worker is never accidentally deleted.
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
