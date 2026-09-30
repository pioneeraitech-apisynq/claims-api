import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

/**
 * Returns the namespace for the given product type, e.g. `policy-wording-home`
 * or `policy-wording-auto`. Keeping one namespace per product type lets
 * Pinecone route each query within a small, focused namespace instead of
 * scanning the entire shared index and applying a metadata filter.
 */
export function policyWordingNamespace(productType: string): string {
  const prefix = process.env.PINECONE_NAMESPACE_PREFIX || 'policy-wording';
  return `${prefix}-${productType}`;
}
