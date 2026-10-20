import Redis from 'ioredis';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Shared Redis connection.
 *
 * Redis backs two things in this service: a short-lived distributed lock so a
 * claim is never triaged twice concurrently, and a cache of triage results so a
 * repeat triage call within the TTL does not re-run the model.
 *
 * SECURITY – TLS:
 *   REDIS_URL must use the `rediss://` scheme for all non-localhost deployments
 *   so that cached PII and lock keys are transmitted over TLS. The ioredis
 *   client is constructed with `tls.rejectUnauthorized: true`; supply a custom
 *   CA via NODE_EXTRA_CA_CERTS if the server uses a self-signed certificate.
 *
 * SECURITY – Encryption:
 *   Cached triage results may contain PII (claimantName, claimantEmail,
 *   dateOfBirth, medicalNotes, financial figures). They are encrypted with
 *   AES-256-GCM before being written to Redis, using the key in
 *   REDIS_CACHE_ENCRYPTION_KEY (32 hex-encoded bytes = 64 hex chars).
 *   Generate with: `openssl rand -hex 32`
 */
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    client = new Redis(url, {
      // null = unlimited retries within the auto-reconnect window (ioredis
      // default). Two retries was too aggressive for transient network blips.
      maxRetriesPerRequest: null,
      lazyConnect: false,
      // Enforce TLS certificate validation when a rediss:// URL is supplied.
      tls: { rejectUnauthorized: true },
    });

    // ioredis emits 'error' on every failed reconnect attempt. Without a
    // listener, Node.js converts unhandled EventEmitter errors into uncaught
    // exceptions that crash the process.
    client.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error('[redis] connection error', err);
    });
  }
  return client;
}

/**
 * Gracefully close the shared Redis connection.
 * Call this from a SIGTERM / NestJS OnApplicationShutdown handler.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

// ---------------------------------------------------------------------------
// Distributed-lock helpers
// ---------------------------------------------------------------------------

const LOCK_TTL_SECONDS = 60;

/**
 * Acquire a per-claim triage lock via a single Redis `SET NX EX`.
 *
 * ⚠️  SINGLE-NODE LIMITATION: This implementation uses one Redis instance and
 * is therefore **not safe in clustered or HA deployments** (e.g. Redis
 * Sentinel or Redis Cluster with automatic failover). If the primary fails and
 * a replica is promoted before the key has been replicated, two workers can
 * simultaneously believe they hold the lock. For production distributed
 * deployments, replace this with the Redlock algorithm across ≥ 3 independent
 * Redis nodes (https://redis.io/docs/manual/patterns/distributed-locks/).
 * This pattern is acceptable only when REDIS_URL points to a single,
 * non-replicated Redis instance.
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

// ---------------------------------------------------------------------------
// Triage-result cache with AES-256-GCM encryption
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96-bit IV recommended for GCM
const TAG_BYTES = 16;  // 128-bit auth tag

function getEncryptionKey(): Buffer {
  const hex = process.env.REDIS_CACHE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'REDIS_CACHE_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: openssl rand -hex 32',
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt `plaintext` with AES-256-GCM.
 * Returns a base64 string: <12-byte IV> + <16-byte tag> + <ciphertext>
 */
function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a value produced by `encrypt`.
 */
function decrypt(encoded: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
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
