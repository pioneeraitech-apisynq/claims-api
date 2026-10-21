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
// Egress monitoring
// ---------------------------------------------------------------------------

/**
 * Simple in-process egress counter (bytes returned in metadata).
 *
 * On Starter (1 GB/month) and Builder (10 GB/month) Pinecone plans, reads that
 * return record data are hard-blocked once the monthly allowance is exhausted.
 * This counter tracks estimated metadata bytes for the current process lifetime
 * so that operational alerts (logs, APM, etc.) can fire before the cap is hit.
 *
 * For production-grade monitoring complement this with:
 *   • Pinecone console → Metrics → Read units / Egress
 *   • A scheduled check against the Pinecone Stats API
 *   • An alert threshold well below your plan's monthly cap
 */
let egressBytesThisProcess = 0;

/** Warn once per process when estimated egress exceeds this threshold (bytes). */
const EGRESS_WARN_THRESHOLD_BYTES =
  Number(process.env.PINECONE_EGRESS_WARN_BYTES) || 50 * 1024 * 1024; // 50 MB

function trackEgress(clauses: PolicyClause[]): void {
  const estimatedBytes = clauses.reduce(
    (sum, c) => sum + c.text.length + c.heading.length + c.clauseId.length,
    0,
  );
  egressBytesThisProcess += estimatedBytes;

  if (egressBytesThisProcess >= EGRESS_WARN_THRESHOLD_BYTES) {
    // Use console.warn so the message surfaces in structured log pipelines
    // without throwing — callers must not be blocked by monitoring logic.
    console.warn(
      '[pinecone] Estimated policy-wording egress exceeded threshold',
      {
        egressBytesThisProcess,
        thresholdBytes: EGRESS_WARN_THRESHOLD_BYTES,
        action:
          'Check Pinecone console metrics and consider upgrading your plan or enabling clause caching.',
      },
    );
  }
}

// ---------------------------------------------------------------------------
// In-process clause cache
// ---------------------------------------------------------------------------

/**
 * Shallow LRU-style cache keyed by "<productType>:<narrative-hash>" to avoid
 * re-fetching (and re-paying egress for) identical queries within the same
 * process lifetime.  The cache is intentionally small and bounded.
 */
const CLAUSE_CACHE_MAX = Number(process.env.PINECONE_CLAUSE_CACHE_MAX) || 256;
const clauseCache = new Map<string, PolicyClause[]>();

function cacheKey(narrative: string, productType: string): string {
  // A lightweight fingerprint — not cryptographic, just collision-resistant
  // enough to distinguish different narratives in an LRU cache.
  let hash = 0;
  for (let i = 0; i < narrative.length; i++) {
    hash = (Math.imul(31, hash) + narrative.charCodeAt(i)) | 0;
  }
  return `${productType}:${hash}`;
}

function getFromCache(key: string): PolicyClause[] | undefined {
  const hit = clauseCache.get(key);
  if (hit) {
    // Refresh recency: delete + re-insert keeps the key at the "newest" end.
    clauseCache.delete(key);
    clauseCache.set(key, hit);
  }
  return hit;
}

function setInCache(key: string, clauses: PolicyClause[]): void {
  if (clauseCache.size >= CLAUSE_CACHE_MAX) {
    // Evict the oldest entry (first key in insertion order).
    clauseCache.delete(clauseCache.keys().next().value);
  }
  clauseCache.set(key, clauses);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function searchPolicyWording(
  narrative: string,
  productType: string,
  topK = 4,
): Promise<PolicyClause[]> {
  const key = cacheKey(narrative, productType);
  const cached = getFromCache(key);
  if (cached) {
    return cached;
  }

  const vector = await embedQuery(narrative);

  // includeMetadata: true is required for the triage agent to quote clause
  // text.  If you only need IDs for a scoring pass, set includeMetadata: false
  // and follow up with a targeted fetch only for the clauses you will surface.
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

  trackEgress(clauses);
  setInCache(key, clauses);
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
