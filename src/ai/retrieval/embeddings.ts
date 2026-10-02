import { embed, embedMany } from 'ai';
import { EMBEDDING_MODEL, openai, withOpenAIRetry } from '../openai.provider';

/**
 * Embeddings for policy wording retrieval, produced with OpenAI
 * text-embedding-3-small through the same gateway-aware provider as the rest of
 * the OpenAI traffic.
 */
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
