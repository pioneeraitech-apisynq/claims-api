import { embedClauses, embedQuery } from './embeddings';
import { POLICY_WORDING_NAMESPACE, policyWordingIndex } from './pinecone.client';

/**
 * Retrieval-augmented search over policy wording.
 *
 * The claim narrative is embedded and matched against the clause index in
 * Pinecone. The top clauses are handed to the triage agent so its decision
 * cites the wording it relied on rather than inventing one.
 */

export interface PolicyClause {
  clauseId: string;
  productType: string;
  heading: string;
  text: string;
  score: number;
}

/**
 * Retries `fn` with exponential backoff whenever Pinecone responds with HTTP
 * 429 TOO_MANY_REQUESTS (the hard 100 req/s per-namespace limit). Other errors
 * are re-thrown immediately.
 *
 * Delays: 250 ms → 500 ms → 1 000 ms → 2 000 ms (4 attempts total).
 */
async function withPineconeRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 4;
  const baseDelayMs = 250;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRateLimit =
        err instanceof Error &&
        (err.message.includes('429') ||
          err.message.toLowerCase().includes('too many requests') ||
          (err as { status?: number }).status === 429);

      if (!isRateLimit || attempt === maxAttempts) {
        throw err;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Unreachable — TypeScript needs a return here.
  throw new Error('withPineconeRetry: exhausted retries');
}

export async function searchPolicyWording(
  narrative: string,
  productType: string,
  topK = 4,
): Promise<PolicyClause[]> {
  const vector = await embedQuery(narrative);

  // NOTE (egress): `includeMetadata: true` returns full clause text inline on
  // every triage request. On Starter / Builder plans this egress accumulates
  // quickly against the monthly read allowance (1 GB / 10 GB respectively) and
  // Pinecone will block further reads once the limit is reached. If egress
  // becomes a concern, store large clause text in an external store (e.g.
  // MongoDB), keep only lightweight metadata in Pinecone, and fetch full text
  // by `clauseId` on demand.
  const result = await withPineconeRetry(() =>
    policyWordingIndex()
      .namespace(POLICY_WORDING_NAMESPACE)
      .query({
        vector,
        topK,
        includeMetadata: true,
        filter: { productType: { $eq: productType } },
      }),
  );

  return (result.matches || []).map((match) => {
    const metadata = (match.metadata || {}) as Record<string, unknown>;
    return {
      clauseId: match.id,
      productType: String(metadata.productType || productType),
      heading: String(metadata.heading || ''),
      text: String(metadata.text || ''),
      score: match.score ?? 0,
    };
  });
}

/**
 * Index (or re-index) the clauses of a product wording document. Run when a
 * wording is published or amended.
 */
export async function indexPolicyWording(
  productType: string,
  clauses: { clauseId: string; heading: string; text: string }[],
): Promise<number> {
  const vectors = await embedClauses(clauses.map((clause) => clause.text));

  await withPineconeRetry(() =>
    policyWordingIndex()
      .namespace(POLICY_WORDING_NAMESPACE)
      .upsert(
        clauses.map((clause, index) => ({
          id: clause.clauseId,
          values: vectors[index],
          metadata: {
            productType,
            heading: clause.heading,
            text: clause.text,
          },
        })),
      ),
  );

  return clauses.length;
}
