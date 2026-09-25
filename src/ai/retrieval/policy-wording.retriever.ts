import { createHash } from 'crypto';
import { embedClauses, embedQuery } from './embeddings';
import { POLICY_WORDING_NAMESPACE, policyWordingIndex } from './pinecone.client';
import { getRedis } from '../../cache/redis.client';

/**
 * Retrieval-augmented search over policy wording.
 *
 * The claim narrative is embedded and matched against the clause index in
 * Pinecone. The top clauses are handed to the triage agent so its decision
 * cites the wording it relied on rather than inventing one.
 *
 * Results are cached in Redis to avoid repeated Pinecone egress for identical
 * (narrative, productType, topK) inputs. Every cache-miss query logs the
 * clause count and estimated egress bytes so consumption can be monitored and
 * alerted on.
 */

export interface PolicyClause {
  clauseId: string;
  productType: string;
  heading: string;
  text: string;
  score: number;
}

/** TTL for cached clause results (15 minutes). */
const CLAUSE_CACHE_TTL_SECONDS = 900;

/**
 * Build a stable, short cache key for a retrieval request.
 * We hash the full narrative so long strings don't bloat the key space.
 */
function buildCacheKey(
  narrative: string,
  productType: string,
  topK: number,
): string {
  const hash = createHash('sha256')
    .update(narrative)
    .digest('hex')
    .slice(0, 32);
  return `policy:wording:clauses:${productType}:k${topK}:${hash}`;
}

/**
 * Emit egress monitoring metrics for a Pinecone query result.
 * Replace these console lines with your metrics SDK (Datadog, CloudWatch, …)
 * when one is available — the shape is intentionally kept simple so it is easy
 * to swap out.
 */
function logEgress(
  productType: string,
  clauseCount: number,
  estimatedBytes: number,
): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'pinecone_egress',
      productType,
      clauseCount,
      estimatedBytes,
    }),
  );

  // Warn when a single query returns an unusually large payload (> 50 kB) so
  // that alerts can be wired to this log line before a plan limit is hit.
  if (estimatedBytes > 50_000) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: 'pinecone_egress_high',
        productType,
        clauseCount,
        estimatedBytes,
        message:
          'Single policy-wording query exceeded 50 kB — review topK or clause chunking',
      }),
    );
  }
}

export async function searchPolicyWording(
  narrative: string,
  productType: string,
  topK = 4,
): Promise<PolicyClause[]> {
  const cacheKey = buildCacheKey(narrative, productType, topK);
  const redis = getRedis();

  // --- cache read ---
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as PolicyClause[];
  }

  // --- cache miss: query Pinecone ---
  const vector = await embedQuery(narrative);

  const result = await policyWordingIndex()
    .namespace(POLICY_WORDING_NAMESPACE)
    .query({
      vector,
      topK,
      includeMetadata: true,
      filter: { productType: { $eq: productType } },
    });

  const clauses: PolicyClause[] = (result.matches || []).map((match) => {
    const metadata = (match.metadata || {}) as Record<string, unknown>;
    return {
      clauseId: match.id,
      productType: String(metadata.productType || productType),
      heading: String(metadata.heading || ''),
      text: String(metadata.text || ''),
      score: match.score ?? 0,
    };
  });

  // --- egress monitoring ---
  const estimatedBytes = clauses.reduce(
    (sum, c) => sum + c.text.length + c.heading.length + c.clauseId.length,
    0,
  );
  logEgress(productType, clauses.length, estimatedBytes);

  // --- cache write ---
  await redis.set(cacheKey, JSON.stringify(clauses), 'EX', CLAUSE_CACHE_TTL_SECONDS);

  return clauses;
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

  await policyWordingIndex()
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
    );

  return clauses.length;
}
