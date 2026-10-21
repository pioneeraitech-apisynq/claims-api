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
 * Name of the namespace *alias* that always points to the live policy-wording
 * namespace. Use the Pinecone console (or the Aliases API) to atomically
 * repoint this alias to a freshly-indexed namespace whenever new wording is
 * published — no redeployment or maintenance window required.
 *
 * To set up:
 *   1. Index new wording into a versioned namespace (e.g. "policy-wording-v2").
 *   2. Create / update the alias "policy-wording-current" → "policy-wording-v2"
 *      via the Pinecone console or: pc.indexes.namespaces.aliases.upsert(...)
 *   3. All queries and upserts below automatically resolve to the new namespace.
 *
 * PINECONE_NAMESPACE_ALIAS overrides the alias name at deploy time if needed.
 */
export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-current';
