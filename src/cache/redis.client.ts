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
      // Rely on the ioredis default (null = retry until reconnected) rather than
      // a hard limit of 2, so a brief Redis hiccup does not immediately surface
      // as a ConflictException in the triage lock path. (Finding 3)
      lazyConnect: false,
      // Exponential back-off: 2^attempt * 50 ms, capped at 2 s. (Finding 3)
      retryStrategy(times: number): number {
        return Math.min(2 ** times * 50, 2000);
      },
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Encryption helpers (Finding 1)
//
// Triage results may be derived from claims that contain PII (claimantEmail,
// dateOfBirth) and medical notes.  Even though those raw fields are not part of
// TriageAgentOutput, we encrypt every cached value at the application layer so
// that a plain-text Redis transport or a Redis dump cannot expose the payload.
//
// Key: 32-byte hex string in REDIS_CACHE_ENCRYPTION_KEY.
// Algorithm: AES-256-GCM (authenticated encryption – detects tampering).
// Wire format: <12-byte IV (hex)>:<16-byte auth-tag (hex)>:<ciphertext (hex)>
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const KEY_BYTES = 32;

function getCacheKey(): Buffer {
  const raw = process.env.REDIS_CACHE_ENCRYPTION_KEY ?? '';
  if (raw.length !== KEY_BYTES * 2) {
    throw new Error(
      'REDIS_CACHE_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)',
    );
  }
  return Buffer.from(raw, 'hex');
}

function encrypt(plaintext: string): string {
  const key = getCacheKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decrypt(encoded: string): string {
  const key = getCacheKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('Cached triage value has unexpected format');
  }
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return (
    decipher.update(ciphertext).toString('utf8') +
    decipher.final().toString('utf8')
  );
}

// ---------------------------------------------------------------------------

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

export async function releaseTriageLock(claimId: string): Promise<void> {
  await getRedis().del(`claims:triage:lock:${claimId}`);
}

export async function readCachedTriage<T>(claimId: string): Promise<T | null> {
  const raw = await getRedis().get(`claims:triage:result:${claimId}`);
  if (!raw) {
    return null;
  }
  // Decrypt before deserialising. (Finding 1)
  const plaintext = decrypt(raw);
  return JSON.parse(plaintext) as T;
}

export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  // Encrypt the serialised payload before writing to Redis. (Finding 1)
  const encrypted = encrypt(JSON.stringify(value));
  await getRedis().set(
    `claims:triage:result:${claimId}`,
    encrypted,
    'EX',
    ttlSeconds,
  );
}
