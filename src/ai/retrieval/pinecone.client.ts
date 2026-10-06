import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      // Pin to the current stable API version so behaviour is deterministic
      // regardless of future SDK upgrades. Required for namespace aliases,
      // full-text search, and the Documents API.
      apiVersion: '2026-07',
    });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

/**
 * Stable alias name used in every query and upsert. Point this alias to a new
 * physical namespace via the Pinecone namespace-aliases API after a re-index is
 * complete to achieve atomic, zero-downtime data swaps (blue/green indexing).
 *
 * To promote a new namespace, run (once indexing is finished):
 *   await getPinecone().index(indexName).updateNamespaceAlias(
 *     POLICY_WORDING_NAMESPACE,
 *     { namespace: '<new-physical-namespace>' },
 *   );
 */
export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE || 'policy-wording-current';
