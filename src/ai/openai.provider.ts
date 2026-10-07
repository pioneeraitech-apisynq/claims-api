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

const RETRYABLE_STATUS_CODES = new Set([429, 503]);
const MAX_RETRY_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * Fetch wrapper that honours the `Retry-After` header on rate-limit (429) and
 * overload (503) responses, and falls back to capped exponential backoff when
 * the header is absent. This ensures the client never hammers the API with
 * immediate blind retries, which would worsen throttling.
 */
async function fetchWithRetryAfterBackoff(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let attempt = 0;

  while (true) {
    const response = await fetch(input, init);

    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= MAX_RETRY_ATTEMPTS) {
      return response;
    }

    // Prefer the server-specified wait time; fall back to exponential backoff.
    const retryAfterHeader = response.headers.get('Retry-After');
    let delayMs: number;

    if (retryAfterHeader !== null) {
      const seconds = parseFloat(retryAfterHeader);
      delayMs = isFinite(seconds) && seconds >= 0
        ? seconds * 1_000
        : Date.parse(retryAfterHeader) - Date.now();
      // Guard against a clock-skew or unparseable date returning a negative value.
      delayMs = Math.max(0, delayMs);
    } else {
      // Exponential backoff: 500 ms, 1 s, 2 s, 4 s … capped at 30 s.
      delayMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt += 1;
  }
}

export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  fetch: fetchWithRetryAfterBackoff,
});

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'gpt-4o-mini';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Models that do not accept a `temperature` (or `top_p`) parameter.
 * Passing those parameters to these models causes an API error.
 */
export const MODELS_WITHOUT_TEMPERATURE = new Set<string>(['gpt-6-astra']);

/** Returns true when the given model identifier supports a custom temperature. */
export function modelSupportsTemperature(model: string): boolean {
  return !MODELS_WITHOUT_TEMPERATURE.has(model);
}
