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

/**
 * Model used by the claim triage agent.
 *
 * ⚠️  MIGRATION NOTICE — gpt-6-astra
 * GPT-6 Astra does NOT support tool calling / structured output through the
 * Chat Completions endpoint. `triage.agent.ts` uses `generateObject` (which
 * maps to Chat Completions tool-calling under the @ai-sdk/openai adapter).
 * Before bumping this constant to 'gpt-6-astra' you MUST migrate the triage
 * agent to the OpenAI Responses API. See the OpenAI Responses migration guide
 * and the guard in triage.agent.ts that will throw a clear error if this
 * constant is changed without also migrating the call-site.
 *
 * GPT-6 Astra also does NOT accept `temperature` or `top_p` — those parameters
 * have already been removed from the generateObject call in triage.agent.ts.
 */
export const TRIAGE_MODEL = 'gpt-4o-mini';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/**
 * Retry wrapper for OpenAI API calls.
 *
 * OpenAI returns HTTP 429 (rate-limited / slow_down) and 503
 * (server_is_overloaded) with an optional `Retry-After` header that tells the
 * caller how many seconds to wait before the next attempt. The Vercel AI
 * SDK's built-in `maxRetries` does not inspect that header and retries
 * immediately, which can worsen a rate-limit situation.
 *
 * `withOpenAIRetry` wraps any async factory and:
 *   1. On a 429 or 503, reads the `Retry-After` header (in seconds).
 *   2. If the header is present, waits exactly that long before retrying.
 *   3. If the header is absent, applies full-jitter exponential backoff
 *      starting at 1 s and capped at 60 s.
 *   4. Gives up after `maxAttempts` total tries and re-throws the last error.
 *
 * The Vercel AI SDK surfaces the underlying HTTP status on the error object
 * through the `statusCode` property that `APICallError` exposes. We duck-type
 * against that shape so we do not take a hard compile-time dependency on the
 * internal error class.
 */

const RETRYABLE_STATUS_CODES = new Set([429, 503]);
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 4; // 1 original attempt + 3 retries

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Duck-typed shape of @ai-sdk/provider APICallError */
interface MaybeApiError {
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  response?: { headers?: { get?: (name: string) => string | null } };
}

function retryDelayMs(err: MaybeApiError, attempt: number): number {
  // Prefer the structured headers bag (most reliable across SDK versions).
  const headerValue =
    err.responseHeaders?.['retry-after'] ??
    err.responseHeaders?.['Retry-After'] ??
    err.response?.headers?.get?.('retry-after') ??
    null;

  if (headerValue !== null && headerValue !== undefined) {
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1_000;
    }
  }

  // No Retry-After header — full-jitter exponential backoff.
  // delay = random(0, min(cap, base * 2^attempt))
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  return Math.random() * ceiling;
}

export async function withOpenAIRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = DEFAULT_MAX_ATTEMPTS }: { maxAttempts?: number } = {},
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      const status = (err as MaybeApiError)?.statusCode;
      if (!RETRYABLE_STATUS_CODES.has(status as number)) {
        throw err; // non-retryable error — fail immediately
      }

      if (attempt === maxAttempts - 1) {
        break; // exhausted all attempts
      }

      await sleep(retryDelayMs(err as MaybeApiError, attempt));
    }
  }

  throw lastError;
}
