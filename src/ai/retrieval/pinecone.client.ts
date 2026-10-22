import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    if (!process.env.PINECONE_API_KEY) {
      throw new Error('PINECONE_API_KEY is required but was not set in the environment');
    }
    pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
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
 * Returns the namespace to use for policy-wording reads and writes.
 *
 * When `PINECONE_NAMESPACE_ALIAS` is set the client targets that alias,
 * enabling zero-downtime blue/green data swaps: re-index into a new namespace
 * (e.g. `policy-wording-v2`), then atomically repoint the alias — no code
 * deploy or query downtime required (requires API version 2026-07+).
 *
 * Falls back to `PINECONE_NAMESPACE` or the default literal for environments
 * that have not yet configured an alias.
 */
export function policyWordingNamespace(): string {
  return (
    process.env.PINECONE_NAMESPACE_ALIAS ||
    process.env.PINECONE_NAMESPACE ||
    'policy-wording-v1'
  );
}
