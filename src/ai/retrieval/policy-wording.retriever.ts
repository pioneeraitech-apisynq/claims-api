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
  /**
   * `text` is intentionally omitted here: full clause text is stored in
   * MongoDB (keyed by clauseId) rather than in Pinecone metadata to avoid
   * exhausting plan-level egress allowances. Callers that need the wording
   * must fetch it from the canonical store after this lookup returns.
   */
  score: number;
}

// ---------------------------------------------------------------------------
// Retry / rate-limit helpers
// ---------------------------------------------------------------------------

/**
 * Maximum number of attempts (1 initial + 3 retries) for Pinecone data-plane
 * calls that fail with a 429 TOO_MANY_REQUESTS response.
 */
const MAX_ATTEMPTS = 4;

/** Base delay (ms) for exponential back-off on 429 responses. */
const BACKOFF_BASE_MS = 250;

/**
 * Returns true when an error looks like a Pinecone 429 response.
 * The SDK surfaces the HTTP status on `error.status` (number) or within the
 * message string as a fallback.
 */
function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e['status'] === 429) return true;
    if (typeof e['message'] === 'string' && e['message'].includes('429'))
      return true;
  }
  return false;
}

/**
 * Executes `fn`, retrying up to MAX_ATTEMPTS times when a 429 is received,
 * with exponential back-off plus ±10 % jitter.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      lastError = err;
      const baseDelay = BACKOFF_BASE_MS * 2 ** attempt;
      const jitter = baseDelay * 0.1 * (Math.random() * 2 - 1); // ±10 %
      await new Promise((resolve) =>
        setTimeout(resolve, Math.round(baseDelay + jitter)),
      );
    }
  }

  // Unreachable, but satisfies the TypeScript compiler.
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

  const result = await withRetry(() =>
    policyWordingIndex()
      .namespace(POLICY_WORDING_NAMESPACE)
      .query({
        vector,
        topK,
        // Only lightweight metadata (heading) is stored in Pinecone now.
        // Full clause text must be fetched from MongoDB using clauseId.
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
      score: match.score ?? 0,
    };
  });
}

/**
 * Index (or re-index) the clauses of a product wording document. Run when a
 * wording is published or amended.
 *
 * NOTE: `text` is no longer stored in Pinecone metadata to keep egress within
 * plan allowances. The authoritative text lives in MongoDB; only the clauseId
 * reference is needed here.
 */
export async function indexPolicyWording(
  productType: string,
  clauses: { clauseId: string; heading: string; text: string }[],
): Promise<number> {
  const vectors = await embedClauses(clauses.map((clause) => clause.text));

  await withRetry(() =>
    policyWordingIndex()
      .namespace(POLICY_WORDING_NAMESPACE)
      .upsert(
        clauses.map((clause, index) => ({
          id: clause.clauseId,
          values: vectors[index],
          // Store only the lightweight reference fields — not the full text —
          // to avoid egress-allowance exhaustion on every query.
          metadata: {
            productType,
            heading: clause.heading,
          },
        })),
      ),
  );

  return clauses.length;
}
