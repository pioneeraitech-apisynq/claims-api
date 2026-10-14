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
// Retry helper
// ---------------------------------------------------------------------------

/**
 * Retry wrapper for OpenAI API calls.
 *
 * On a 429 (rate-limit / slow_down) or 503 (server_is_overloaded) response the
 * OpenAI API may include a `Retry-After` header whose value is the minimum
 * number of seconds the caller must wait before retrying. This wrapper:
 *
 *  1. Reads that header when present and waits at least that long.
 *  2. Falls back to full-jitter exponential backoff when the header is absent.
 *  3. Re-throws immediately on any other error so non-retryable failures surface
 *     without delay.
 */

const RETRYABLE_STATUS_CODES = new Set([429, 503]);

/** Maximum number of attempts (1 initial + N-1 retries). */
const MAX_ATTEMPTS = 4;

/** Base delay for exponential backoff in milliseconds. */
const BASE_DELAY_MS = 500;

/** Hard ceiling for a single backoff sleep in milliseconds. */
const MAX_DELAY_MS = 30_000;

/**
 * Extract the numeric Retry-After value (in seconds) from an error thrown by
 * the AI SDK or the raw `node-fetch` / `undici` response surface.  The AI SDK
 * wraps provider errors in objects that expose `status` and `responseHeaders`.
 */
function parseRetryAfterMs(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;

  const e = err as Record<string, unknown>;

  // AI SDK provider errors expose a `responseHeaders` map.
  const headers = e['responseHeaders'];
  if (headers !== null && typeof headers === 'object') {
    const hdrs = headers as Record<string, string>;
    const raw =
      hdrs['retry-after'] ??
      hdrs['Retry-After'] ??
      hdrs['x-ratelimit-reset-requests'] ??
      null;
    if (raw !== null) {
      const seconds = parseFloat(raw);
      if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
    }
  }

  return null;
}

/** Returns true when the error looks like a rate-limit or overload response. */
function isRetryable(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const status = (err as Record<string, unknown>)['status'];
  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full-jitter exponential backoff delay for attempt number `attempt` (0-based).
 * See: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
function jitteredBackoffMs(attempt: number): number {
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt));
  return Math.random() * cap;
}

/**
 * Execute `fn` with automatic retry on retryable OpenAI errors.
 *
 * @param fn  An async factory that performs one OpenAI call and returns its result.
 * @returns   The resolved value of `fn` on the first successful attempt.
 * @throws    The last error if all attempts are exhausted, or immediately for
 *            non-retryable errors.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isRetryable(err)) {
        throw err;
      }

      lastError = err;

      const retryAfterMs = parseRetryAfterMs(err);
      const delayMs =
        retryAfterMs !== null
          ? Math.max(retryAfterMs, jitteredBackoffMs(attempt))
          : jitteredBackoffMs(attempt);

      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}
