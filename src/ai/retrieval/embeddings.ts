import { embed, embedMany, AISDKError } from 'ai';
import { EMBEDDING_MODEL, openai } from '../openai.provider';

/**
 * Embeddings for policy wording retrieval, produced with OpenAI
 * text-embedding-3-small through the same gateway-aware provider as the rest of
 * the OpenAI traffic.
 */
export async function embedQuery(text: string): Promise<number[]> {
  try {
    const { embedding } = await embed({
      model: openai.embedding(EMBEDDING_MODEL),
      value: text,
    });
    return embedding;
  } catch (err) {
    if (AISDKError.isInstance(err)) {
      // SDK-level failure (e.g. InvalidResponseDataError).
      // Re-throw with a clear message so callers can surface a meaningful
      // diagnostic or apply a retry strategy instead of seeing an unclassified
      // error.
      throw Object.assign(
        new Error(`Embedding model error [${err.name}]: ${err.message}`),
        { cause: err, isSdkError: true },
      );
    }
    throw err;
  }
}

export async function embedClauses(texts: string[]): Promise<number[][]> {
  try {
    const { embeddings } = await embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: texts,
    });
    return embeddings;
  } catch (err) {
    if (AISDKError.isInstance(err)) {
      // SDK-level failure (e.g. InvalidResponseDataError).
      // Re-throw with a clear message so callers can surface a meaningful
      // diagnostic or apply a retry strategy instead of seeing an unclassified
      // error.
      throw Object.assign(
        new Error(`Embedding model error [${err.name}]: ${err.message}`),
        { cause: err, isSdkError: true },
      );
    }
    throw err;
  }
}
