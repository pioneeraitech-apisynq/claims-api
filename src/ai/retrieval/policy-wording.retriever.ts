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
// Namespace helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Pinecone namespace for a given product type, e.g.
 * `policy-wording-v1/home` or `policy-wording-v1/auto`.
 *
 * Keeping product types in isolated namespaces (rather than a single shared
 * namespace filtered by metadata) reduces the per-query RU cost from up to
 * 100 RU to 1 RU, and provides natural access-control isolation.
 */
function productNamespace(productType: string): string {
  return `${POLICY_WORDING_NAMESPACE}/${productType}`;
}

// ---------------------------------------------------------------------------
// Retry / back-off
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [200, 400, 800, 1600] as const;

/**
 * Runs `fn` and retries up to `RETRY_DELAYS_MS.length` times when Pinecone
 * returns a 429 TOO_MANY_REQUESTS response (hard limit: 100 RPS per
 * namespace). Each retry waits an exponentially increasing amount of time
 * before the next attempt.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status =
        (err as { status?: number; statusCode?: number })?.status ??
        (err as { status?: number; statusCode?: number })?.statusCode;
      if (status === 429 && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS_MS[attempt]),
        );
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
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

  // NOTE — egress monitoring: `includeMetadata: true` returns the full
  // `heading` and `text` fields for every match. On Starter plans (1 GB/month
  // egress cap) and Builder plans (10 GB/month) these reads accumulate quickly
  // because policy-wording text fields can be long. Monitor egress in the
  // Pinecone console (Index › Metrics › Egress) and consider upgrading to a
  // Standard/Enterprise plan if triage query volume is high.
  const result = await withRetry(() =>
    policyWordingIndex()
      .namespace(productNamespace(productType))
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

  await withRetry(() =>
    policyWordingIndex()
      .namespace(productNamespace(productType))
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
