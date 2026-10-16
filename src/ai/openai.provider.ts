import { createOpenAI } from '@ai-sdk/openai';

/**
 * Gateway-ready OpenAI provider.
 *
 * The base URL is read from OPENAI_BASE_URL and defaults to the public OpenAI
 * API. Point that one variable at the APISynQ AI gateway
 * (https://governance-api.apisynq.com/v1/ai-gw/openai/v1) and every OpenAI call
 * this service makes — chat completions for triage and embeddings for policy
 * wording retrieval — is routed through the gateway without a code change.
 */
export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'gpt-6-astra';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

// ---------------------------------------------------------------------------
// Retry-with-backoff utility
//
// Retries any async OpenAI call on 429 / 503 responses. The Retry-After
// header is honoured when present; otherwise capped exponential backoff with
// full jitter is used so concurrent callers do not thunderherd.
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of additional attempts after the first failure. Default: 4. */
  maxRetries?: number;
  /** Base delay in milliseconds for the exponential series. Default: 500. */
  baseDelayMs?: number;
  /** Upper bound on the computed delay before jitter is applied. Default: 30_000. */
  maxDelayMs?: number;
}

/** HTTP status codes that warrant a retry. */
const RETRYABLE_STATUSES = new Set([429, 503]);

function isRetryable(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;

  // AI SDK / fetch-style errors expose `status` or `statusCode`.
  const status =
    typeof e['status'] === 'number'
      ? e['status']
      : typeof e['statusCode'] === 'number'
        ? e['statusCode']
        : null;

  if (status !== null) return RETRYABLE_STATUSES.has(status);

  // Fallback: inspect the message text for well-known rate-limit signals.
  const msg =
    typeof e['message'] === 'string' ? e['message'].toLowerCase() : '';
  return (
    msg.includes('rate limit') ||
    msg.includes('slow_down') ||
    msg.includes('server_is_overloaded') ||
    msg.includes('overloaded')
  );
}

/**
 * Parse a Retry-After header value (seconds integer or HTTP-date string) into
 * milliseconds. Returns null when the value is absent or unparseable.
 */
function parseRetryAfterMs(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;

  // The AI SDK surfaces response headers under `responseHeaders`, or nested
  // inside a `cause` object. Walk both shapes.
  const headers: Record<string, string> | null =
    (e['responseHeaders'] as Record<string, string> | undefined) ??
    ((e['cause'] as Record<string, unknown> | undefined)?.[
      'responseHeaders'
    ] as Record<string, string> | undefined) ??
    null;

  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'] ?? null;

  if (!raw) return null;

  // Seconds form: "30"
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  // HTTP-date form: "Wed, 01 Jan 2025 00:00:30 GMT"
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps an async OpenAI call with Retry-After-aware exponential backoff.
 *
 * @example
 *   const result = await withRetry(() => generateObject({ ... }));
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 4, baseDelayMs = 500, maxDelayMs = 30_000 } = options;

  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;

      const retryAfterMs = parseRetryAfterMs(err);
      let delayMs: number;

      if (retryAfterMs !== null) {
        // Always respect the server's explicit guidance.
        delayMs = retryAfterMs;
      } else {
        // Exponential backoff: base * 2^attempt, capped, then full jitter.
        const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        delayMs = Math.random() * exponential;
      }

      await sleep(delayMs);
      attempt += 1;
    }
  }
}
