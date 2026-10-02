import Redis from 'ioredis';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto';

/**
 * Shared Redis connection.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 */
let client: Redis | null = null;

// ---------------------------------------------------------------------------
// Encryption helpers (Finding #4)
// ---------------------------------------------------------------------------
// Derive a fixed-length 32-byte key from whatever string is supplied so the
// env var doesn't have to be exactly 64 hex chars.
function getEncryptionKey(): Buffer {
  const secret = process.env.REDIS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'REDIS_ENCRYPTION_KEY env var is required for Redis cache encryption',
    );
  }
  return createHash('sha256').update(secret).digest();
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // 96-bit IV for AES-GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Store as <iv_hex>:<authTag_hex>:<ciphertext_hex>
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted Redis value');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });

    // Finding #2: attach error handler so ioredis reconnection failures do not
    // surface as unhandled 'error' events and crash the process.
    client.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error('Redis client error', err);
    });
  }
  return client;
}

/**
 * Gracefully close the Redis connection.
 * Call this during application shutdown (see main.ts).
 * Finding #6.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

// ---------------------------------------------------------------------------
// Distributed lock — TTL raised to 300 s (Finding #5)
// ---------------------------------------------------------------------------

// Upper-bound TTL for the triage lock.  The triage path makes two Policy API
// calls, runs an LLM, and writes to MongoDB.  60 s was too tight under LLM
// latency spikes; 300 s gives a conservative safety margin while still
// ensuring the lock is eventually released if the process dies.
const LOCK_TTL_SECONDS = 300;

// Lua script for atomic compare-and-delete (Finding #1).
// Returns 1 when the key was deleted, 0 when the value did not match (i.e.
// the lock was already taken over by a different worker).
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
 * Release the triage lock **only** if this process still owns it.
 *
 * Uses an atomic Lua script so a worker whose TTL already expired cannot
 * silently delete a lock that was re-acquired by a different worker.
 * Finding #1.
 */
export async function releaseTriageLock(claimId: string): Promise<void> {
  await getRedis().eval(
    RELEASE_LOCK_SCRIPT,
    1,
    `claims:triage:lock:${claimId}`,
    process.pid.toString(),
  );
}

// ---------------------------------------------------------------------------
// Triage result cache — encrypted (Finding #4)
// ---------------------------------------------------------------------------

export async function readCachedTriage<T>(claimId: string): Promise<T | null> {
  const raw = await getRedis().get(`claims:triage:result:${claimId}`);
  if (!raw) return null;
  const plaintext = decrypt(raw);
  return JSON.parse(plaintext) as T;
}

export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  const ciphertext = encrypt(JSON.stringify(value));
  await getRedis().set(
    `claims:triage:result:${claimId}`,
    ciphertext,
    'EX',
    ttlSeconds,
  );
}
