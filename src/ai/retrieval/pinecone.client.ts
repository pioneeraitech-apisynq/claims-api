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
      // Explicitly target the 2026-07 API version to enable the Documents API,
      // full-text search, and namespace aliases (findings #2 & #3).
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
 * The name of the namespace alias that points to the active policy-wording
 * namespace. Using an alias (rather than a hardcoded namespace name) means
 * the alias can be atomically repointed to a freshly loaded namespace in
 * Pinecone's control plane — enabling zero-downtime wording updates without
 * a code or config deployment (finding #3).
 *
 * To resolve the alias to its backing namespace at query/upsert time, call:
 *   const { namespaceName } = await policyWordingIndex()
 *                               .describeNamespaceAlias(POLICY_WORDING_NAMESPACE_ALIAS);
 * then pass `namespaceName` to `.namespace()`.
 */
export const POLICY_WORDING_NAMESPACE_ALIAS =
  process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-current';

/**
 * Resolves the namespace alias to its current backing namespace name and
 * returns a bound namespace handle. All reads and writes go through this
 * function so that repointing the alias in Pinecone is instantly reflected
 * without any application redeployment.
 */
export async function policyWordingNamespace() {
  const index = policyWordingIndex();
  const { namespaceName } = await index.describeNamespaceAlias(
    POLICY_WORDING_NAMESPACE_ALIAS,
  );
  return index.namespace(namespaceName);
}
