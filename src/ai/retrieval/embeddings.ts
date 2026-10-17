import { embed, embedMany } from 'ai';
import { EMBEDDING_MODEL, openai } from '../openai.provider';

/**
 * Embeddings for policy wording retrieval, produced with OpenAI
 * text-embedding-3-small through the same gateway-aware provider as the rest of
 * the OpenAI traffic.
 */

/** Maximum number of attempts for a rate-limited or overloaded embedding call. */
const MAX_RETRIES = 4;
/** Base delay in ms for exponential backoff when no Retry-After header is present. */
const BASE_BACKOFF_MS = 1_000;

/**
 * Runs fn with Retry-After–aware exponential backoff.
 *
 * Retries on 429 (rate limit / slow_down) and 503 (server_is_overloaded).
 * Honours the `retry-after` response header when present; otherwise uses
 * exponential backoff (1 s, 2 s, 4 s, …) with ±10 % jitter.
 */
async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt += 1;
      if (attempt >= MAX_RETRIES) throw err;

      const status =
        (err as { status?: number })?.status ??
        (err as { statusCode?: number })?.statusCode;
      const isRateLimitOrOverload = status === 429 || status === 503;
      if (!isRateLimitOrOverload) throw err;

      // Respect the Retry-After header when the API provides one.
      const retryAfterHeader: string | undefined =
        (err as { responseHeaders?: Record<string, string> })
          ?.responseHeaders?.['retry-after'];
      const retryAfterMs = retryAfterHeader
        ? parseFloat(retryAfterHeader) * 1_000
        : BASE_BACKOFF_MS * Math.pow(2, attempt - 1);

      // Add ±10 % jitter to avoid correlated retries.
      const jitter = retryAfterMs * 0.1 * (Math.random() * 2 - 1);
      const delay = Math.max(0, retryAfterMs + jitter);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await withBackoff(() =>
    embed({
      model: openai.embedding(EMBEDDING_MODEL),
      value: text,
    }),
  );
  return embedding;
}

export async function embedClauses(texts: string[]): Promise<number[][]> {
  const { embeddings } = await withBackoff(() =>
    embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: texts,
    }),
  );
  return embeddings;
}
