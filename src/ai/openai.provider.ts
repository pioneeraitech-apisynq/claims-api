import { createOpenAI } from '@ai-sdk/openai';

// ---------------------------------------------------------------------------
// Retry-After / exponential-backoff fetch wrapper (findings: risky/high #2)
//
// OpenAI mandates that callers honour the Retry-After header on 429 and 503
// responses and, when the header is absent, apply exponential backoff.
// The Vercel AI SDK's built-in maxRetries fires immediately, so we replace
// the underlying fetch with a wrapper that sleeps appropriately first.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

async function fetchWithBackoff(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let attempt = 0;

  while (true) {
    const response = await fetch(input, init);

    const retryable = response.status === 429 || response.status === 503;

    if (!retryable || attempt >= MAX_ATTEMPTS - 1) {
      return response;
    }

    // Honour Retry-After header (value in seconds, as per RFC 7231).
    const retryAfterHeader = response.headers.get('retry-after');
    let delayMs: number;

    if (retryAfterHeader !== null) {
      const seconds = parseFloat(retryAfterHeader);
      delayMs = isFinite(seconds)
        ? Math.min(seconds * 1_000, MAX_DELAY_MS)
        : MAX_DELAY_MS;
    } else {
      // Exponential backoff with full jitter when the header is absent.
      const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
      const capped = Math.min(exponential, MAX_DELAY_MS);
      delayMs = Math.random() * capped;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt++;
  }
}

// ---------------------------------------------------------------------------
// Gateway-ready OpenAI provider.
//
// The base URL is read from OPENAI_BASE_URL and defaults to the public OpenAI
// API. Point that one variable at the APISynQ AI gateway
// (https://governance-api.apisynq.com/v1/ai-gw/openai/v1) and every OpenAI call
// this service makes — chat completions for triage and embeddings for policy
// wording retrieval — is routed through the gateway without a code change.
// ---------------------------------------------------------------------------
export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  fetch: fetchWithBackoff,
});

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'gpt-6-astra';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
