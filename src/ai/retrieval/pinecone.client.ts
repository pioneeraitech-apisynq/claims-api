import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    // Finding 4: guard against a missing env var so failures are caught at
    // startup with a clear message rather than as an opaque auth error later.
    if (!process.env.PINECONE_API_KEY) {
      throw new Error(
        'PINECONE_API_KEY is not set — add it to your environment before starting the service',
      );
    }
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pinecone;
}

// Finding 2: return a typed index handle; the physical index must be created
// with a schema-based definition (dense-vector + BM25 fields) via the
// Pinecone console or a one-off migration script using pc.createIndex with a
// `schema` field rather than the legacy dimension/metric/spec model.
export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

// Finding 5: the active namespace is resolved through a namespace alias
// ("policy-wording-current") rather than a hard-coded version string.
// During a re-index, write vectors into a fresh target namespace and then
// atomically point the alias at it via pc.updateNamespaceAlias — readers
// never observe a mixed-state window.
export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE || 'policy-wording-current';

/**
 * Atomically swap the "policy-wording-current" alias to point at
 * `targetNamespace`. Call this after a successful re-index to make the new
 * data live with zero downtime.
 *
 * Usage:
 *   await indexPolicyWording(productType, clauses, 'policy-wording-v2');
 *   await swapPolicyWordingNamespace('policy-wording-v2');
 */
export async function swapPolicyWordingNamespace(
  targetNamespace: string,
): Promise<void> {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  await getPinecone().updateNamespaceAlias(indexName, {
    aliasName: POLICY_WORDING_NAMESPACE,
    targetNamespace,
  });
}
