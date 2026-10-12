import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 *
 * The index is schema-based (Documents API, GA on API version 2026-07) so that
 * retrieval benefits from hybrid BM25 + dense matching — critical for exact
 * clause-heading and legal-term lookups that pure cosine similarity misses.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pinecone;
}

/** Name of the schema-based index. */
export function policyWordingIndexName(): string {
  return process.env.PINECONE_INDEX || 'policy-wording';
}

export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE || 'policy-wording-v1';

/**
 * Returns a handle to the schema-based index for use with the Documents API.
 * The generic parameter tells the SDK which fields are present on each document.
 */
export function policyWordingDocumentIndex() {
  return getPinecone().index<{
    text: string;
    productType: string;
    heading: string;
  }>(policyWordingIndexName());
}

/**
 * Legacy dense-vector index handle (kept for the old `.query()` path).
 * @deprecated Use `policyWordingDocumentIndex()` instead.
 */
export function policyWordingIndex() {
  return getPinecone().index(policyWordingIndexName());
}

/**
 * Idempotently creates the schema-based policy-wording index if it does not
 * already exist. Call this once during application bootstrap or a migration
 * script before ingesting any documents.
 *
 * Schema fields:
 *  - `text`        — BM25 full-text field (the clause body).
 *  - `productType` — stored metadata for filtering.
 *  - `heading`     — stored metadata returned with each hit.
 *
 * The dense vector field is implicitly created by the Documents API from the
 * `text` field using the index's configured embedding model.
 */
export async function ensurePolicyWordingIndex(
  dimension = 1536,
  metric: 'cosine' | 'dotproduct' | 'euclidean' = 'cosine',
): Promise<void> {
  const pc = getPinecone();
  const name = policyWordingIndexName();

  const { indexes = [] } = await pc.listIndexes();
  if (indexes.some((idx) => idx.name === name)) {
    return; // already exists
  }

  await pc.createIndex({
    name,
    dimension,
    metric,
    spec: {
      serverless: {
        cloud: (process.env.PINECONE_CLOUD as 'aws' | 'gcp' | 'azure') || 'aws',
        region: process.env.PINECONE_REGION || 'us-east-1',
      },
    },
    schema: {
      fields: [
        { name: 'text', type: 'text' },          // BM25 full-text
        { name: 'productType', type: 'string' }, // filterable metadata
        { name: 'heading', type: 'string' },     // returned with hits
      ],
    },
  });
}
