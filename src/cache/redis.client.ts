import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import {
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';

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
  }
  return client;
}

/**
 * Gracefully close the Redis connection. Call this from onModuleDestroy /
 * app shutdown hooks so the process does not hang on open TCP sockets.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

const LOCK_TTL_SECONDS = 60;

/**
 * Lua script for atomic compare-and-delete.
 * Deletes the key only when its value equals ARGV[1]; returns 1 on success, 0 otherwise.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * Acquire a lock for a claim. Returns the unique lock token on success, or
 * null when another worker already holds the lock.
 *
 * The token is a cryptographically random UUID so it is globally unique across
 * every host and container restart — unlike process.pid, which collides across
 * hosts in multi-instance deployments.
 */
export async function acquireTriageLock(
  claimId: string,
): Promise<string | null> {
  try {
    const token = randomUUID();
    const result = await getRedis().set(
      `claims:triage:lock:${claimId}`,
      token,
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );
    return result === 'OK' ? token : null;
  } catch (err) {
    throw new ServiceUnavailableException(
      `Cache lock unavailable for claim ${claimId}: ${(err as Error).message}`,
    );
  }
}

/**
 * Release the lock only when the stored token matches the one supplied by the
 * caller. The check-and-delete is performed atomically via a Lua script to
 * prevent a slow worker from evicting a lock it no longer owns.
 */
export async function releaseTriageLock(
  claimId: string,
  token: string,
): Promise<void> {
  try {
    await getRedis().eval(
      RELEASE_LOCK_SCRIPT,
      1,
      `claims:triage:lock:${claimId}`,
      token,
    );
  } catch (err) {
    // Non-fatal: the TTL will expire the lock anyway; log and move on.
    console.error(
      `Failed to release triage lock for claim ${claimId}:`,
      err,
    );
  }
}

export async function readCachedTriage<T>(claimId: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(`claims:triage:result:${claimId}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    // Cache read failure is non-fatal — degrade gracefully by returning null.
    console.error(`Failed to read triage cache for claim ${claimId}:`, err);
    return null;
  }
}

export async function deleteCachedTriage(claimId: string): Promise<void> {
  try {
    await getRedis().del(`claims:triage:result:${claimId}`);
  } catch (err) {
    console.error(
      `Failed to delete triage cache for claim ${claimId}:`,
      err,
    );
  }
}

/**
 * Persists a triage result to Redis. Sensitive medical fields are stripped
 * before serialisation so that a Redis snapshot (RDB/AOF) or breach does not
 * expose protected health information.
 */
export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  try {
    // Strip any sensitive health fields before writing to the shared cache.
    const { medicalNotes: _omit, ...safeValue } = value as Record<
      string,
      unknown
    >;
    await getRedis().set(
      `claims:triage:result:${claimId}`,
      JSON.stringify(safeValue),
      'EX',
      ttlSeconds,
    );
  } catch (err) {
    throw new InternalServerErrorException(
      `Failed to write triage cache for claim ${claimId}: ${(err as Error).message}`,
    );
  }
}
