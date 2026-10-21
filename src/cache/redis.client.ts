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

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Application-layer encryption for cached triage data (AES-256-GCM).
//
// Triage results contain PII/PHI (claimantEmail, medicalNotes,
// claimedAmountCents, etc.) and must never be stored in Redis as plain JSON.
//
// Key material: REDIS_CACHE_ENCRYPTION_KEY must be a 64-character hex string
// (32 bytes). Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV — recommended for GCM
const AUTH_TAG_BYTES = 16;

function getCacheEncryptionKey(): Buffer {
  const raw = process.env.REDIS_CACHE_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'REDIS_CACHE_ENCRYPTION_KEY is not set. ' +
        'Generate a 32-byte hex key and add it to your environment: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  // Accept either a 64-char hex string or a passphrase — normalise to 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Fallback: derive a 32-byte key from any other string via SHA-256 so the
  // service can start with a non-hex secret (not recommended for production).
  return createHash('sha256').update(raw).digest();
}

/**
 * Encrypt a JSON-serialisable value with AES-256-GCM.
 *
 * Output format (all base64-encoded, pipe-delimited):
 *   <iv_base64>|<authTag_base64>|<ciphertext_base64>
 */
function encryptJson(value: unknown): string {
  const key = getCacheEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(value);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join('|');
}

/**
 * Decrypt a value previously produced by `encryptJson`.
 * Returns `null` if the ciphertext cannot be parsed or authentication fails,
 * so a corrupted or legacy plain-JSON entry silently expires rather than
 * crashing the service.
 */
function decryptJson<T>(raw: string): T | null {
  try {
    const parts = raw.split('|');
    if (parts.length !== 3) {
      return null;
    }
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const key = getCacheEncryptionKey();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      return null;
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  } catch {
    // Authentication failure (tampered data) or malformed JSON — treat as a
    // cache miss so the caller re-runs the triage agent.
    return null;
  }
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
  return decryptJson<T>(raw);
}

export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  await getRedis().set(
    `claims:triage:result:${claimId}`,
    encryptJson(value),
    'EX',
    ttlSeconds,
  );
}
