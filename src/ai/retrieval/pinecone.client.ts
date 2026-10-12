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
 * Returns the namespace object for policy wording reads and writes.
 *
 * The value of PINECONE_NAMESPACE_ALIAS is a **namespace alias** — a stable
 * pointer managed in the Pinecone control plane. To perform a zero-downtime
 * blue/green data swap:
 *   1. Populate a new physical namespace (e.g. `policy-wording-v2`).
 *   2. Call the Pinecone Aliases API to atomically repoint the alias to the
 *      new namespace.
 * No code change or service restart is required; both reads and writes here
 * will automatically follow the alias.
 */
export function policyWordingNamespace() {
  const alias =
    process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-current';
  return policyWordingIndex().namespace(alias);
}
