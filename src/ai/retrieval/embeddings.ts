import { embed, embedMany } from 'ai';
import { EMBEDDING_MODEL, openai } from '../openai.provider';

/**
 * Embeddings for policy wording retrieval, produced with OpenAI
 * text-embedding-3-small through the same gateway-aware provider as the rest of
 * the OpenAI traffic.
 */

/** Maximum number of texts that may be embedded in a single embedMany call. */
const EMBED_MANY_MAX = 100;

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.embedding(EMBEDDING_MODEL),
    value: text,
  });
  return embedding;
}

export async function embedClauses(texts: string[]): Promise<number[][]> {
  if (texts.length > EMBED_MANY_MAX) {
    throw new Error(
      `embedClauses: input exceeds the maximum batch size of ${EMBED_MANY_MAX} ` +
        `(received ${texts.length}). Split the input into chunks of at most ` +
        `${EMBED_MANY_MAX} before calling embedClauses to prevent silently ` +
        `misaligned embeddings.`,
    );
  }

  const { embeddings } = await embedMany({
    model: openai.embedding(EMBEDDING_MODEL),
    values: texts,
  });
  return embeddings;
}
