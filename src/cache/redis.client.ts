import Redis from 'ioredis';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Application-layer encryption for cached triage data
//
// Triage results contain PII/PHI (medicalNotes, claimedAmountCents,
// claimantEmail). We encrypt them with AES-256-GCM before writing to Redis so
// that any process with raw Redis access cannot read sensitive claim data.
//
// Required env var:
//   REDIS_ENCRYPTION_KEY — 64 hex characters (32 bytes).
//   Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96-bit IV recommended for GCM
const TAG_BYTES = 16;  // GCM auth tag length

function getEncryptionKey(): Buffer {
  const hex = process.env.REDIS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'REDIS_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns a base64-encoded blob: <12-byte IV> | <ciphertext> | <16-byte auth tag>
 */
function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv (12) | tag (16) | ciphertext (variable)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypts a blob produced by `encrypt`. Throws if the auth tag does not match
 * (i.e. the data has been tampered with or the wrong key is used).
 */
function decrypt(blob: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
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
  if (!raw) return null;
  return JSON.parse(decrypt(raw)) as T;
}

export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  await getRedis().set(
    `claims:triage:result:${claimId}`,
    encrypt(JSON.stringify(value)),
    'EX',
    ttlSeconds,
  );
}
