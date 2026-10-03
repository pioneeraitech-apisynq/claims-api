import { embed, embedMany } from 'ai';
import { EMBEDDING_MODEL, openai } from '../openai.provider';

/**
 * Embeddings for policy wording retrieval, produced with OpenAI
 * text-embedding-3-small through the same gateway-aware provider as the rest of
 * the OpenAI traffic.
 */

// ---------------------------------------------------------------------------
// Retry-After / exponential-backoff helper
//
// OpenAI returns 429 ("slow_down") when traffic is increasing too quickly and
// 503 ("server_is_overloaded") on temporary model overload. Both may include a
// Retry-After header. When present we wait at least as long as specified before
// retrying; when absent we fall back to exponential backoff with full jitter.
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set([429, 503]);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;

function retryAfterMs(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null;
  const headers = (error as Record<string, unknown>)['responseHeaders'];
  if (!headers) return null;

  let value: string | null = null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    value = (headers as Headers).get('retry-after');
  } else if (
    typeof (headers as Record<string, unknown>)['retry-after'] === 'string'
  ) {
    value = (headers as Record<string, string>)['retry-after'];
  }

  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds) * 1_000;
  }

  const target = Date.parse(value);
  if (!Number.isNaN(target)) {
    return Math.max(0, target - Date.now());
  }

  return null;
}

function isRetryable(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const status = (error as Record<string, unknown>)['statusCode'];
  return typeof status === 'number' && RETRYABLE_STATUSES.has(status);
}

function exponentialBackoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetryAfterBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= maxRetries) {
        throw error;
      }
      const waitMs = retryAfterMs(error) ?? exponentialBackoffMs(attempt);
      await sleep(waitMs);
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await withRetryAfterBackoff(() =>
    embed({
      model: openai.embedding(EMBEDDING_MODEL),
      value: text,
    }),
  );
  return embedding;
}

export async function embedClauses(texts: string[]): Promise<number[][]> {
  const { embeddings } = await withRetryAfterBackoff(() =>
    embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: texts,
    }),
  );
  return embeddings;
}
