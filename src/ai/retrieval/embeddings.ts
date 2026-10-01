import { embed, embedMany, APICallError } from 'ai';
import { EMBEDDING_MODEL, openai } from '../openai.provider';

/**
 * Embeddings for policy wording retrieval, produced with OpenAI
 * text-embedding-3-small through the same gateway-aware provider as the rest of
 * the OpenAI traffic.
 */

// ---------------------------------------------------------------------------
// Retry helper – respects Retry-After on 429/503, exponential back-off otherwise
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

async function withOpenAIRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      const isRetryable =
        err instanceof APICallError &&
        err.statusCode !== undefined &&
        RETRYABLE_STATUSES.has(err.statusCode);

      if (!isRetryable || attempt >= MAX_ATTEMPTS) {
        throw err;
      }

      // Honour Retry-After header when the server provides one (value in seconds).
      const retryAfterRaw =
        err instanceof APICallError
          ? (err.responseHeaders?.['retry-after'] ?? null)
          : null;
      const retryAfterMs = retryAfterRaw
        ? parseFloat(retryAfterRaw) * 1_000
        : null;

      const backoffMs = Math.min(
        BASE_DELAY_MS * 2 ** (attempt - 1),
        MAX_DELAY_MS,
      );
      const delayMs =
        retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : backoffMs;

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await withOpenAIRetry(() =>
    embed({
      model: openai.embedding(EMBEDDING_MODEL),
      value: text,
    }),
  );
  return embedding;
}

export async function embedClauses(texts: string[]): Promise<number[][]> {
  const { embeddings } = await withOpenAIRetry(() =>
    embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: texts,
    }),
  );
  return embeddings;
}
