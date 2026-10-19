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

/**
 * Derive ioredis options from REDIS_URL.
 *
 * - If the URL uses the `rediss://` scheme (or points to a non-loopback host
 *   with a plain `redis://` scheme) TLS is enabled automatically.
 * - maxRetriesPerRequest is set to null (ioredis unlimited-retry default) so
 *   that transient network blips on the locking path do not surface as
 *   premature command errors and cause spurious 409 Conflict responses.
 */
function buildRedisOptions(url: string): { url: string; tls?: object } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable URL — pass through and let ioredis surface the error.
    return { url };
  }

  const isLoopback =
    parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';

  // Upgrade to TLS when the scheme is already rediss://, or when connecting to
  // a remote host over a plain redis:// scheme (finding #3).
  if (parsed.protocol === 'rediss:' || (!isLoopback && parsed.protocol === 'redis:')) {
    const tls: URL = new URL(url);
    tls.protocol = 'rediss:';
    return { url: tls.toString(), tls: {} };
  }

  return { url };
}

export function getRedis(): Redis {
  if (!client) {
    throw new Error(
      'Redis client has not been initialised — call initRedis() during bootstrap.',
    );
  }
  return client;
}

/**
 * Establish the Redis connection eagerly at application startup (finding #5).
 * Call this inside bootstrap() before the app starts accepting traffic.
 */
export async function initRedis(): Promise<void> {
  if (client) return;

  const rawUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const { url, tls } = buildRedisOptions(rawUrl);

  client = new Redis(url, {
    // null → unlimited retries within the connection-retry window; prevents
    // premature command failures on the distributed-lock path (finding #7).
    maxRetriesPerRequest: null,
    lazyConnect: true,
    ...(tls ? { tls } : {}),
  });

  // Attach an error listener immediately so ioredis errors are never emitted
  // to an EventEmitter with no listener (which would crash the process) (finding #2).
  client.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error('Redis client error', err);
  });

  // Connect eagerly so startup failures are caught here, not inside a request
  // handler (finding #5).
  await client.connect();
}

/**
 * Gracefully close the Redis connection on shutdown (finding #8).
 * Wire this into a SIGTERM / NestJS shutdown-hook handler in main.ts.
 */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}

// ---------------------------------------------------------------------------
// Distributed lock
// ---------------------------------------------------------------------------

/**
 * Raise the TTL well above the worst-case triage duration (two Policy API round
 * trips + LLM inference).  300 s gives a conservative 5-minute ceiling before
 * the lock auto-expires, reducing (but not eliminating) the race window
 * described in finding #6.  Callers should also set an explicit deadline on
 * runTriageAgent() that is shorter than this value.
 */
const LOCK_TTL_SECONDS = 300;

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
 * Release the lock only when it is still owned by this process.
 *
 * The check-and-delete is executed as an atomic Lua script via EVAL so there
 * is no TOCTOU window between the GET and the DEL (finding #1).
 */
export async function releaseTriageLock(claimId: string): Promise<void> {
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;
  await getRedis().eval(script, 1, `claims:triage:lock:${claimId}`, process.pid.toString());
}

// ---------------------------------------------------------------------------
// Triage result cache  (AES-256-GCM envelope encryption — finding #4)
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96-bit IV recommended for GCM
const TAG_BYTES = 16;  // GCM authentication tag length

/**
 * Return a 32-byte key derived from the REDIS_CACHE_KEY environment variable.
 * The env var is expected to be a 64-character hex string (256 bits).
 * A missing or short key is a hard startup error — fail loudly rather than
 * silently storing plaintext PII.
 */
function getCacheKey(): Buffer {
  const hex = process.env.REDIS_CACHE_KEY ?? '';
  if (hex.length < 64) {
    throw new Error(
      'REDIS_CACHE_KEY must be a 64-character hex string (256 bits). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hex.slice(0, 64), 'hex');
}

/**
 * Encrypt `plaintext` with AES-256-GCM.
 * Returns a single base64 string: iv (12 B) | tag (16 B) | ciphertext.
 */
function encrypt(plaintext: string): string {
  const key = getCacheKey();
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
  const key = getCacheKey();
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
  try {
    return JSON.parse(decrypt(raw)) as T;
  } catch {
    // Corrupted or legacy plaintext entry — treat as a cache miss.
    return null;
  }
}

export async function writeCachedTriage(
  claimId: string,
  value: unknown,
  ttlSeconds = 900,
): Promise<void> {
  const payload = encrypt(JSON.stringify(value));
  await getRedis().set(
    `claims:triage:result:${claimId}`,
    payload,
    'EX',
    ttlSeconds,
  );
}
