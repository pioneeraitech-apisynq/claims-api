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
 * Returns the namespace that isolates vectors for a specific product type,
 * e.g. "policy-wording-v1:home" or "policy-wording-v1:auto".
 * Using per-productType namespaces costs 1 RU per query regardless of corpus
 * size, versus up to 100 RUs when filtering across a shared namespace.
 */
function namespaceForProductType(productType: string): string {
  return `${POLICY_WORDING_NAMESPACE}:${productType}`;
}

/**
 * Runs `fn` with simple exponential backoff, retrying only on HTTP 429
 * (TOO_MANY_REQUESTS) responses from the Pinecone data-plane.
 * Pinecone enforces a 100 RPS per-namespace limit; under concurrent
 * claim-triage load this limit can be hit and must be handled gracefully.
 */
async function withBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 250,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt += 1;
      const status =
        (err as { status?: number })?.status ??
        (err as { statusCode?: number })?.statusCode;
      const is429 = status === 429;
      if (!is429 || attempt >= maxAttempts) {
        throw err;
      }
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
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

  const result = await withBackoff(() =>
    policyWordingIndex()
      .namespace(namespaceForProductType(productType))
      .query({
        vector,
        topK,
        includeMetadata: true,
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

  await withBackoff(() =>
    policyWordingIndex()
      .namespace(namespaceForProductType(productType))
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
