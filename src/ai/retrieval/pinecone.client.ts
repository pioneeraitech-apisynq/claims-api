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
 * Stable namespace alias that always points to the currently-live wording
 * namespace. Re-indexing jobs write into a new physical namespace (e.g.
 * `policy-wording-v2`) and then atomically repoint this alias via the
 * Pinecone REST API (2026-07+), giving zero-downtime blue/green swaps with
 * no redeployment required.
 *
 * Both the query path and the upsert path in policy-wording.retriever.ts
 * reference this alias name so they always resolve to the same live data.
 */
export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-current';
