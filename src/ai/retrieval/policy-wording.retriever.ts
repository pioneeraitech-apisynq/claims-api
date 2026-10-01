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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Pinecone namespace for a given product type.
 *
 * Storing each product type in its own namespace avoids the cost of a
 * full-corpus metadata filter at query time (finding 4 — per-productType
 * namespace isolation).
 */
function namespaceFor(productType: string): string {
  return `${POLICY_WORDING_NAMESPACE}-${productType}`;
}

/**
 * Calls `fn` with exponential back-off whenever Pinecone responds with a
 * 429 TOO_MANY_REQUESTS (rate-limit) error (finding 1).
 *
 * Strategy: up to `maxAttempts` tries; first retry waits `baseDelayMs`,
 * each subsequent wait doubles plus a small random jitter to spread bursts.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  {
    maxAttempts = 5,
    baseDelayMs = 200,
  }: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt += 1;
      const isRateLimit =
        err instanceof Error &&
        (err.message.includes('429') ||
          err.message.toLowerCase().includes('too many requests'));

      if (!isRateLimit || attempt >= maxAttempts) {
        throw err;
      }

      const jitterMs = Math.random() * baseDelayMs;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitterMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function searchPolicyWording(
  narrative: string,
  productType: string,
  topK = 4,
): Promise<PolicyClause[]> {
  const vector = await embedQuery(narrative);

  // Finding 3: use the Documents API (2026-07) `searchRecords` instead of the
  // legacy `query` vector endpoint.
  // Finding 4: query only the per-productType namespace — no metadata filter needed.
  const result = await withRetry(() =>
    policyWordingIndex()
      .namespace(namespaceFor(productType))
      .searchRecords({
        query: { inputs: { vector }, topK },
        fields: ['productType', 'heading', 'text'],
      }),
  );

  return (result.result?.hits || []).map((hit) => {
    const fields = (hit.fields || {}) as Record<string, unknown>;
    return {
      clauseId: hit._id,
      productType: String(fields.productType || productType),
      heading: String(fields.heading || ''),
      text: String(fields.text || ''),
      score: hit._score ?? 0,
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

  // Finding 3: use the Documents API `upsertRecords` instead of the legacy
  // `upsert` vector endpoint.
  // Finding 4: write into the per-productType namespace.
  await withRetry(() =>
    policyWordingIndex()
      .namespace(namespaceFor(productType))
      .upsertRecords(
        clauses.map((clause, index) => ({
          id: clause.clauseId,
          values: vectors[index],
          productType,
          heading: clause.heading,
          text: clause.text,
        })),
      ),
  );

  return clauses.length;
}
