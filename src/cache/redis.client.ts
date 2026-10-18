import Redis from 'ioredis';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

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
      maxRetriesPerRequest: 10,
      lazyConnect: false,
      retryStrategy(times: number) {
        // Exponential back-off capped at 10 s; give up after 20 consecutive
        // failures so the process doesn't spin indefinitely.
        if (times > 20) return null;
        return Math.min(100 * Math.pow(2, times), 10_000);
      },
    });

    // Attach an error listener immediately so that connection failures never
    // surface as uncaught exceptions that crash the Node.js process (finding #2).
    client.on('error', (err: Error) => {
      console.error('[redis] connection error:', err.message);
    });

    // Graceful shutdown: close the Redis connection when the process is asked
    // to stop so Kubernetes / PM2 rolling restarts finish cleanly (finding #6).
    const shutdown = async () => {
      if (client) {
        await client.quit().catch(() => client?.disconnect());
      }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Encryption helpers (finding #4)
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_HEX = process.env.REDIS_ENCRYPTION_KEY ?? '';

function getEncryptionKey(): Buffer {
  if (!ENCRYPTION_KEY_HEX || ENCRYPTION_KEY_HEX.length !== 64) {
    throw new Error(
      'REDIS_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)',
    );
  }
  return Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
}

/**
 * Encrypts `plaintext` with AES-256-GCM.
 * Returns a single base-64 string: <12-byte IV>:<16-byte auth-tag>:<ciphertext>
 */
function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypts a value produced by `encrypt`.
 */
function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = ciphertext.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Distributed lock (finding #1)
// ---------------------------------------------------------------------------

const LOCK_TTL_SECONDS = 60;

/**
 * Lua script for atomic ownership-checked lock release (finding #1).
 * Returns 1 if the key was deleted, 0 if the caller no longer owns the lock.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
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
 * Release the triage lock only if this process still owns it (finding #1).
 * Uses an atomic Lua script to prevent deleting a lock held by another worker.
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
// Triage result cache (findings #4)
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
