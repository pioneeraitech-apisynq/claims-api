import { embed, embedMany } from 'ai';
import { EMBEDDING_MODEL, openai } from '../openai.provider';

/**
 * Embeddings for policy wording retrieval, produced with OpenAI
 * text-embedding-3-small through the same gateway-aware provider as the rest of
 * the OpenAI traffic.
 */

/** Status codes that warrant a retry with backoff. */
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

/**
 * Retries `fn` up to `maxAttempts` times on 429 / 503 errors.
 *
 * - If the error response includes a `Retry-After` header (seconds), the delay
 *   is at least that long, as required by the OpenAI best-practice guidance.
 * - Otherwise exponential backoff is used: baseMs * 2^attempt + jitter.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseMs = 500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // Extract HTTP status and Retry-After from the error if present.
      const status: number | undefined =
        err != null &&
        typeof err === 'object' &&
        'status' in err &&
        typeof (err as Record<string, unknown>).status === 'number'
          ? ((err as Record<string, unknown>).status as number)
          : undefined;

      if (status === undefined || !RETRYABLE_STATUS_CODES.has(status)) {
        throw err;
      }

      if (attempt === maxAttempts - 1) {
        break;
      }

      // Honour Retry-After when the server sends it.
      const retryAfterHeader: string | undefined =
        err != null &&
        typeof err === 'object' &&
        'headers' in err &&
        err.headers != null &&
        typeof (err as Record<string, unknown>).headers === 'object'
          ? ((err as Record<string, { 'retry-after'?: string }>).headers[
              'retry-after'
            ] as string | undefined)
          : undefined;

      const retryAfterMs = retryAfterHeader
        ? parseFloat(retryAfterHeader) * 1_000
        : NaN;

      const backoffMs = baseMs * Math.pow(2, attempt);
      const jitterMs = Math.random() * baseMs;
      const delayMs = Number.isFinite(retryAfterMs)
        ? Math.max(retryAfterMs, backoffMs + jitterMs)
        : backoffMs + jitterMs;

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await withRetry(() =>
    embed({
      model: openai.embedding(EMBEDDING_MODEL),
      value: text,
    }),
  );
  return embedding;
}

export async function embedClauses(texts: string[]): Promise<number[][]> {
  const { embeddings } = await withRetry(() =>
    embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: texts,
    }),
  );
  return embeddings;
}
